//! Icon extraction from the player's own texture atlases (BC1/BC3) → PNG. Port of core/icons.js.
use crate::{pak, Res};
use flate2::{write::ZlibEncoder, Compression};
use std::collections::HashMap;
use std::fs::File;
use std::io::Write;

pub struct Rect { x: u32, y: u32, w: u32, h: u32 }
pub struct TexInfo { fmt: u32, w: u32, h: u32, pub sprites: HashMap<u32, Rect>, data_off: usize }

fn u16le(b: &[u8], o: usize) -> u32 { u16::from_le_bytes([b[o], b[o + 1]]) as u32 }
fn u32le(b: &[u8], o: usize) -> u32 { u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]) }

pub fn tex_info(d: &[u8]) -> Option<TexInfo> {
    if d.len() < 0x30 { return None; }
    let (mips, one, fmt, w, h, ns) = (u32le(d, 4), u32le(d, 8), u32le(d, 12), u32le(d, 16), u32le(d, 20), u32le(d, 24));
    if one != 1 || w < 1 || h < 1 || w > 8192 || h > 8192 || ns > 4000 { return None; }
    if 0x1c + ns as usize * 12 > d.len() { return None; }
    let mut sprites = HashMap::new();
    for i in 0..ns as usize {
        let o = 0x1c + i * 12;
        sprites.insert(u32le(d, o), Rect { x: u16le(d, o + 4), y: u16le(d, o + 6), w: u16le(d, o + 8), h: u16le(d, o + 10) });
    }
    let bs: usize = if fmt == 2 { 8 } else { 16 };
    let (mut sum, mut ww, mut hh) = (0usize, w as usize, h as usize);
    for _ in 0..mips { sum += ((ww + 3) >> 2).max(1) * ((hh + 3) >> 2).max(1) * bs; ww = (ww >> 1).max(1); hh = (hh >> 1).max(1); }
    if sum > d.len() { return None; }
    Some(TexInfo { fmt, w, h, sprites, data_off: d.len() - sum })
}

fn rgb565(c: u32) -> [u32; 3] {
    let (r, g, b) = ((c >> 11) & 31, (c >> 5) & 63, c & 31);
    [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)]
}

fn decode_block(d: &[u8], off: usize, fmt: u32, out: &mut [u8; 64]) {
    let mut alphas: Option<[u8; 16]> = None;
    let mut co = off;
    if fmt == 4 {
        let (a0, a1) = (d[off] as u32, d[off + 1] as u32);
        let mut tbl = vec![a0, a1];
        if a0 > a1 { for i in 1..=6 { tbl.push(((7 - i) * a0 + i * a1) / 7); } }
        else { for i in 1..=4 { tbl.push(((5 - i) * a0 + i * a1) / 5); } tbl.push(0); tbl.push(255); }
        let mut bits: u64 = 0;
        for i in 0..6 { bits |= (d[off + 2 + i] as u64) << (8 * i); }
        let mut a = [0u8; 16];
        for (i, v) in a.iter_mut().enumerate() { *v = tbl[((bits >> (3 * i)) & 7) as usize] as u8; }
        alphas = Some(a);
        co = off + 8;
    }
    let (c0, c1) = (u16le(d, co), u16le(d, co + 2));
    let (p0, p1) = (rgb565(c0), rgb565(c1));
    let mut pal = [[0u32; 4]; 4];
    pal[0] = [p0[0], p0[1], p0[2], 255];
    pal[1] = [p1[0], p1[1], p1[2], 255];
    if fmt == 4 || c0 > c1 {
        for k in 0..3 { pal[2][k] = (2 * p0[k] + p1[k]) / 3; pal[3][k] = (p0[k] + 2 * p1[k]) / 3; }
        pal[2][3] = 255; pal[3][3] = 255;
    } else {
        for k in 0..3 { pal[2][k] = (p0[k] + p1[k]) / 2; }
        pal[2][3] = 255; pal[3] = [0, 0, 0, 0];
    }
    let idx = u32le(d, co + 4);
    for i in 0..16 {
        let p = pal[((idx >> (2 * i)) & 3) as usize];
        out[i * 4] = p[0] as u8; out[i * 4 + 1] = p[1] as u8; out[i * 4 + 2] = p[2] as u8;
        out[i * 4 + 3] = match alphas { Some(a) => a[i], None => p[3] as u8 };
    }
}

/// Decode a sprite rectangle (upright coordinates) to RGBA. Texture data is stored vertically flipped.
pub fn decode_sprite(d: &[u8], info: &TexInfo, r: &Rect) -> Option<Vec<u8>> {
    if info.fmt != 4 && info.fmt != 2 { return None; }
    if r.x + r.w > info.w || r.y + r.h > info.h { return None; }
    let bs = if info.fmt == 2 { 8 } else { 16 };
    let bw = ((info.w as usize + 3) >> 2).max(1);
    let mut out = vec![0u8; (r.w * r.h * 4) as usize];
    let mut cache: HashMap<usize, [u8; 64]> = HashMap::new();
    let sy0 = info.h - (r.y + r.h);
    let sy1 = info.h - 1 - r.y;
    for sy in sy0..=sy1 {
        let by = (sy >> 2) as usize;
        for x in r.x..r.x + r.w {
            let key = by * bw + (x >> 2) as usize;
            let px = match cache.get(&key) { Some(p) => *p, None => {
                let o = info.data_off + key * bs;
                if o + bs > d.len() { return None; }
                let mut blk = [0u8; 64]; decode_block(d, o, info.fmt, &mut blk); cache.insert(key, blk); blk } };
            let i = (((sy & 3) * 4 + (x & 3)) * 4) as usize;
            let uy = info.h - 1 - sy - r.y;
            let o = ((uy * r.w + (x - r.x)) * 4) as usize;
            out[o..o + 4].copy_from_slice(&px[i..i + 4]);
        }
    }
    Some(out)
}

fn jround(v: f64) -> f64 { (v + 0.5).floor() } // JS Math.round

pub fn downscale(rgba: Vec<u8>, w: u32, h: u32, max_side: u32) -> (Vec<u8>, u32, u32) {
    let s = (max_side as f64 / w.max(h) as f64).min(1.0);
    if s >= 1.0 { return (rgba, w, h); }
    let nw = (jround(w as f64 * s) as u32).max(1);
    let nh = (jround(h as f64 * s) as u32).max(1);
    let mut out = vec![0u8; (nw * nh * 4) as usize];
    for y in 0..nh { for x in 0..nw {
        let x0 = (x as f64 / s).floor() as u32; let x1 = w.min(((x + 1) as f64 / s).floor() as u32);
        let y0 = (y as f64 / s).floor() as u32; let y1 = h.min(((y + 1) as f64 / s).floor() as u32);
        let (mut r, mut g, mut b, mut a, mut n) = (0u64, 0u64, 0u64, 0u64, 0u64);
        for yy in y0..y1.max(y0 + 1) { for xx in x0..x1.max(x0 + 1) {
            let i = ((yy * w + xx) * 4) as usize; let al = rgba[i + 3] as u64;
            r += rgba[i] as u64 * al; g += rgba[i + 1] as u64 * al; b += rgba[i + 2] as u64 * al; a += al; n += 1;
        } }
        let o = ((y * nw + x) * 4) as usize;
        if a > 0 { out[o] = jround(r as f64 / a as f64) as u8; out[o + 1] = jround(g as f64 / a as f64) as u8; out[o + 2] = jround(b as f64 / a as f64) as u8; }
        out[o + 3] = jround(a as f64 / n as f64) as u8;
    } }
    (out, nw, nh)
}

fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &byte in data { c ^= byte as u32; for _ in 0..8 { c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 }; } }
    c ^ 0xffff_ffff
}
fn chunk(out: &mut Vec<u8>, ty: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut td = ty.to_vec(); td.extend_from_slice(data);
    out.extend_from_slice(&td);
    out.extend_from_slice(&crc32(&td).to_be_bytes());
}
pub fn encode_png(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
    let stride = (w * 4) as usize;
    let mut raw = Vec::with_capacity((stride + 1) * h as usize);
    for y in 0..h as usize { raw.push(0); raw.extend_from_slice(&rgba[y * stride..(y + 1) * stride]); }
    let mut z = ZlibEncoder::new(Vec::new(), Compression::new(6)); z.write_all(&raw).unwrap();
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&w.to_be_bytes()); ihdr.extend_from_slice(&h.to_be_bytes()); ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    let mut out = vec![137, 80, 78, 71, 13, 10, 26, 10];
    chunk(&mut out, b"IHDR", &ihdr); chunk(&mut out, b"IDAT", &z.finish().unwrap()); chunk(&mut out, b"IEND", &[]);
    out
}

pub struct Item { pub sprite: u32, pub file: String }
pub struct Job { pub pak: String, pub hash: String, pub items: Vec<Item> }

/// Decode every requested sprite; returns the files written. Unreadable textures are skipped (placeholders in the UI).
pub fn extract(jobs: &[Job], max_side: u32) -> Res<Vec<String>> {
    let mut written = Vec::new();
    let mut dirs: HashMap<String, Option<pak::Dir>> = HashMap::new();
    for job in jobs {
        let dir = dirs.entry(job.pak.clone()).or_insert_with(|| pak::read_dir(&job.pak).ok());
        let Some(dir) = dir else { continue };
        let Some(e) = dir.entries.get(&job.hash) else { continue };
        let Ok(mut f) = File::open(&job.pak) else { continue };
        let Ok(d) = pak::read_entry_from(&mut f, e) else { continue };
        let Some(info) = tex_info(&d) else { continue };
        for it in &job.items {
            let Some(r) = info.sprites.get(&it.sprite) else { continue };
            if r.w < 4 || r.h < 4 { continue; }
            let Some(rgba) = decode_sprite(&d, &info, r) else { continue };
            let (px, w, h) = downscale(rgba, r.w, r.h, max_side);
            if std::fs::write(&it.file, encode_png(&px, w, h)).is_ok() { written.push(it.file.clone()); }
        }
    }
    Ok(written)
}
