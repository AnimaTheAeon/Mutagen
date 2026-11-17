//! PAK2 archives: 'PAK2', u32 ver, u32 count, u32 0, u64 dirOffset @0x10, entries 4 KB aligned,
//! directory = count × 32 bytes { u64 hash, u32 off, u32 csize, u32 aligned, u32 usize, u32 0, u32 flags }.
//! Straight port of core/pak.js.
use crate::{err, Res};
use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};

pub const ZLIB_FLAG: u32 = 0x0100_0000;
const ALIGN: u64 = 0x1000;

#[derive(Clone, Debug)]
pub struct Entry { pub index: usize, pub hash: String, pub off: u32, pub csize: u32, pub aligned: u32, pub usize_: u32, pub flags: u32 }

pub struct Dir { pub count: usize, pub dir_off: u64, pub size: u64, pub dir: Vec<u8>, pub entries: HashMap<String, Entry>, pub order: Vec<String> }

fn u32le(b: &[u8], o: usize) -> u32 { u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) }
fn u64le(b: &[u8], o: usize) -> u64 { let mut a = [0u8; 8]; a.copy_from_slice(&b[o..o + 8]); u64::from_le_bytes(a) }

pub fn read_dir(path: &str) -> Res<Dir> {
    let mut f = File::open(path).map_err(|e| err(&format!("Can't open {path}: {e}"), "IO"))?;
    let size = f.metadata()?.len();
    let mut head = [0u8; 0x20];
    f.read_exact(&mut head).map_err(|_| err(&format!("{path} is not a PAK2 archive."), "PAK"))?;
    if &head[0..4] != b"PAK2" { return Err(err(&format!("{path} is not a PAK2 archive."), "PAK")); }
    let count = u32le(&head, 8) as usize;
    let dir_off = u64le(&head, 0x10);
    if dir_off + (count as u64) * 32 > size { return Err(err("Archive directory is out of range.", "PAK")); }
    let mut dir = vec![0u8; count * 32];
    f.seek(SeekFrom::Start(dir_off))?;
    f.read_exact(&mut dir)?;
    let mut entries = HashMap::with_capacity(count);
    let mut order = Vec::with_capacity(count);
    for i in 0..count {
        let b = i * 32;
        let hash = format!("{:016x}", u64le(&dir, b));
        let e = Entry { index: i, hash: hash.clone(), off: u32le(&dir, b + 8), csize: u32le(&dir, b + 12), aligned: u32le(&dir, b + 16), usize_: u32le(&dir, b + 20), flags: u32le(&dir, b + 28) };
        order.push(hash.clone());
        entries.insert(hash, e);
    }
    Ok(Dir { count, dir_off, size, dir, entries, order })
}

pub fn read_entry_from(f: &mut File, e: &Entry) -> Res<Vec<u8>> {
    let mut c = vec![0u8; e.csize as usize];
    f.seek(SeekFrom::Start(e.off as u64))?;
    f.read_exact(&mut c)?;
    if e.flags & ZLIB_FLAG != 0 {
        let mut u = Vec::with_capacity(e.usize_ as usize);
        ZlibDecoder::new(&c[..]).read_to_end(&mut u).map_err(|x| err(&format!("Entry {}: damaged data ({x})", e.hash), "PAK"))?;
        if u.len() != e.usize_ as usize { return Err(err(&format!("Entry {}: size {} != {}", e.hash, u.len(), e.usize_), "PAK")); }
        Ok(u)
    } else { Ok(c) }
}

pub fn read_entry(path: &str, hash: &str) -> Res<Vec<u8>> {
    let d = read_dir(path)?;
    let e = d.entries.get(hash).ok_or_else(|| err(&format!("Entry {hash} not found in {path}."), "NOT_FOUND"))?;
    let mut f = File::open(path)?;
    read_entry_from(&mut f, e)
}

pub fn deflate9(data: &[u8]) -> Vec<u8> {
    let mut z = ZlibEncoder::new(Vec::new(), Compression::new(9));
    z.write_all(data).unwrap();
    z.finish().unwrap()
}

pub struct PatchReport { pub hash: String, pub mode: &'static str, pub csize: usize }

/// Patch entries in place (call on a copy!). Same layout rules as pak.js patchInPlace.
pub fn patch_in_place(path: &str, replacements: &[(String, Vec<u8>)]) -> Res<Vec<PatchReport>> {
    let mut pak = read_dir(path)?;
    let mut f = OpenOptions::new().read(true).write(true).open(path)?;
    let mut append_at = pak.dir_off;
    let mut report = Vec::new();
    for (hash, data) in replacements {
        let e = pak.entries.get(hash).cloned().ok_or_else(|| err(&format!("Entry {hash} not found in {path}."), "NOT_FOUND"))?;
        let comp = if e.flags & ZLIB_FLAG != 0 { deflate9(data) } else { data.clone() };
        let needed = (comp.len() as u64).div_ceil(ALIGN) * ALIGN;
        let (off, aligned);
        if comp.len() as u64 <= e.aligned as u64 {
            let mut slot = vec![0u8; e.aligned as usize];
            slot[..comp.len()].copy_from_slice(&comp);
            f.seek(SeekFrom::Start(e.off as u64))?; f.write_all(&slot)?;
            off = e.off as u64; aligned = e.aligned as u64;
            report.push(PatchReport { hash: hash.clone(), mode: "in-place", csize: comp.len() });
        } else {
            off = append_at; aligned = needed;
            let mut slot = vec![0u8; needed as usize];
            slot[..comp.len()].copy_from_slice(&comp);
            f.seek(SeekFrom::Start(off))?; f.write_all(&slot)?;
            append_at += needed;
            report.push(PatchReport { hash: hash.clone(), mode: "appended", csize: comp.len() });
        }
        if off > u32::MAX as u64 { return Err(err("Archive would grow past 4 GB.", "PAK")); }
        let b = e.index * 32;
        pak.dir[b + 8..b + 12].copy_from_slice(&(off as u32).to_le_bytes());
        pak.dir[b + 12..b + 16].copy_from_slice(&(comp.len() as u32).to_le_bytes());
        pak.dir[b + 16..b + 20].copy_from_slice(&(aligned as u32).to_le_bytes());
        pak.dir[b + 20..b + 24].copy_from_slice(&(data.len() as u32).to_le_bytes());
    }
    f.seek(SeekFrom::Start(append_at))?; f.write_all(&pak.dir)?;
    let new_end = append_at + pak.dir.len() as u64;
    if append_at != pak.dir_off { f.seek(SeekFrom::Start(0x10))?; f.write_all(&append_at.to_le_bytes())?; }
    if new_end > pak.size { f.set_len(new_end)?; }
    f.sync_all()?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn build(entries: &[(u64, Vec<u8>, bool)]) -> Vec<u8> {
        let mut body = vec![0u8; 0x1000];
        let mut dir = Vec::new();
        for (h, data, z) in entries {
            let off = body.len() as u32;
            let c = if *z { deflate9(data) } else { data.clone() };
            let aligned = (c.len() as u32).div_ceil(0x1000) * 0x1000;
            body.extend_from_slice(&c); body.resize(off as usize + aligned as usize, 0);
            dir.extend_from_slice(&h.to_le_bytes()); dir.extend_from_slice(&off.to_le_bytes()); dir.extend_from_slice(&(c.len() as u32).to_le_bytes());
            dir.extend_from_slice(&aligned.to_le_bytes()); dir.extend_from_slice(&(data.len() as u32).to_le_bytes()); dir.extend_from_slice(&0u32.to_le_bytes());
            dir.extend_from_slice(&(if *z { ZLIB_FLAG } else { 0 }).to_le_bytes());
        }
        let dir_off = body.len() as u64;
        body[0..4].copy_from_slice(b"PAK2"); body[8..12].copy_from_slice(&(entries.len() as u32).to_le_bytes()); body[0x10..0x18].copy_from_slice(&dir_off.to_le_bytes());
        body.extend_from_slice(&dir); body
    }
    #[test]
    fn read_patch_in_place_and_append() {
        let a: Vec<u8> = (0..5000u32).map(|i| (i % 7) as u8).collect();
        let b: Vec<u8> = (0..300u32).map(|i| i as u8).collect();
        let c: Vec<u8> = b"plain entry".to_vec();
        let p = std::env::temp_dir().join("mtg_pak_test.pak2"); let ps = p.to_str().unwrap();
        std::fs::write(&p, build(&[(1, a.clone(), true), (2, b.clone(), true), (3, c.clone(), false)])).unwrap();
        let d = read_dir(ps).unwrap();
        assert_eq!(d.count, 3);
        assert_eq!(read_entry(ps, &format!("{:016x}", 1)).unwrap(), a);
        assert_eq!(read_entry(ps, &format!("{:016x}", 3)).unwrap(), c);
        // small change stays in place; incompressible 20 KB must be appended and the directory moves
        let mut a2 = a.clone(); a2[10] = 99;
        let mut x = 0x9E37_79B9_7F4A_7C15u64; let big: Vec<u8> = (0..20000).map(|_| { x ^= x << 13; x ^= x >> 7; x ^= x << 17; (x >> 24) as u8 }).collect();
        let r = patch_in_place(ps, &[(format!("{:016x}", 1), a2.clone()), (format!("{:016x}", 2), big.clone())]).unwrap();
        assert_eq!(r.iter().map(|x| x.mode).collect::<Vec<_>>(), vec!["in-place", "appended"]);
        assert_eq!(read_entry(ps, &format!("{:016x}", 1)).unwrap(), a2);
        assert_eq!(read_entry(ps, &format!("{:016x}", 2)).unwrap(), big);
        assert_eq!(read_entry(ps, &format!("{:016x}", 3)).unwrap(), c);
        assert!(read_dir(ps).unwrap().dir_off > d.dir_off);
        assert!(read_entry(ps, "ffffffffffffffff").is_err());
        let _ = std::fs::remove_file(&p);
    }
}
