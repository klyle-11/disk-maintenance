//! Listing what is inside zip and rar archives without extracting them.
//!
//! Only the archive's own index is read: a zip's central directory at the
//! end of the file, or a rar's file headers (skipping over the packed data
//! between them). Nothing is decompressed or decrypted, so reading an
//! archive costs a few small reads however big it is, and a solid rar costs
//! the same as any other.
//!
//! Every format stores a checksum of each file's original bytes in that
//! index (CRC-32 in zip and rar, and a BLAKE2sp hash in rar 5 when the
//! archive was made with one). Those let two entries be matched by content
//! without unpacking either one. A CRC-32 is 32 bits: with the size it is a
//! strong hint that two files are the same, not a proof.
//!
//! Passwords: this module never asks for one and never runs an outside tool
//! that could. A zip or rar whose files are encrypted still lists its names
//! and sizes, because only the contents are encrypted. A rar made with
//! "encrypt file names" (and a zip with an encrypted central directory)
//! hides even the names; that is reported as [`ListStatus::Locked`] and the
//! scan moves on.

use serde::Serialize;
use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// An archive with more entries than this is listed up to here and marked
/// [`ListStatus::TooManyEntries`], so a pathological file can't eat memory.
pub const MAX_ENTRIES: usize = 200_000;

/// A single header bigger than this means the file is damaged (or hostile).
const MAX_HEADER: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveFormat {
    Zip,
    /// RAR 1.5 to 4.x.
    Rar4,
    Rar5,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ListStatus {
    /// Every entry was listed.
    Listed,
    /// The file names themselves are encrypted: nothing could be listed
    /// without the password, which is never asked for.
    Locked,
    /// Listed up to [`MAX_ENTRIES`].
    TooManyEntries,
    /// Not a zip or rar after all, damaged, or cut short. Entries read before
    /// the damage are kept.
    Unreadable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveEntry {
    /// Path inside the archive, '/'-separated, no trailing slash.
    pub name: String,
    pub is_dir: bool,
    /// Original (unpacked) size.
    pub size: u64,
    /// Stored (packed) size in this file.
    pub packed: u64,
    /// CRC-32 of the original bytes, when the archive stores a usable one.
    /// Left out for AES-encrypted zip entries (AE-2 stores 0) and for rar 5
    /// entries encrypted with "tweaked" checksums, whose CRC depends on the
    /// password.
    pub crc32: Option<u32>,
    /// BLAKE2sp of the original bytes (rar 5 archives made with it), hex.
    pub blake2sp: Option<String>,
    /// The entry's contents are encrypted (its name and size are not).
    pub encrypted: bool,
}

impl ArchiveEntry {
    /// The checksum two entries can be matched on, tagged with its kind so a
    /// CRC never matches a BLAKE2 value.
    pub fn content_key(&self) -> Option<String> {
        if let Some(b) = &self.blake2sp {
            return Some(format!("blake2sp:{b}"));
        }
        self.crc32.map(|c| format!("crc32:{c:08x}"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveListing {
    pub format: ArchiveFormat,
    pub status: ListStatus,
    pub entries: Vec<ArchiveEntry>,
    /// A rar compressed as one stream. Listing is unaffected; reading any
    /// one file's bytes would mean unpacking everything before it.
    pub solid: bool,
    /// One part of a multi-part (spanned) archive.
    pub multi_volume: bool,
}

impl ArchiveListing {
    fn new(format: ArchiveFormat) -> Self {
        ArchiveListing {
            format,
            status: ListStatus::Listed,
            entries: Vec::new(),
            solid: false,
            multi_volume: false,
        }
    }

    fn push(&mut self, entry: ArchiveEntry) -> bool {
        if self.entries.len() >= MAX_ENTRIES {
            self.status = ListStatus::TooManyEntries;
            return false;
        }
        self.entries.push(entry);
        true
    }
}

/// Whether a file name looks like an archive this module reads. Comic book
/// archives (.cbz, .cbr) are plain zips and rars under another name. Other
/// zip-based formats (.docx, .jar, .apk) are left alone: they are documents
/// and programs, not folders someone packed.
pub fn is_archive_name(name: &str) -> bool {
    let Some((_, ext)) = name.rsplit_once('.') else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "zip" | "cbz" | "rar" | "cbr"
    )
}

/// List the archive at `path`. The format is read from the file's first
/// bytes (a zip is also recognised by its end record, which covers
/// self-extracting zips). Ok(None) when the file is neither a zip nor a rar.
/// `cancel` is checked every few hundred entries.
pub fn list(path: &Path, cancel: &AtomicBool) -> io::Result<Option<ArchiveListing>> {
    let file = File::open(path)?;
    let len = file.metadata()?.len();
    let mut r = BufReader::with_capacity(16 * 1024, file);
    let mut magic = [0u8; 8];
    let got = read_up_to(&mut r, &mut magic)?;
    let magic = &magic[..got];
    if magic.starts_with(RAR5_SIG) {
        return Ok(Some(list_rar5(&mut r, len, cancel)));
    }
    if magic.starts_with(RAR4_SIG) {
        r.seek(SeekFrom::Start(RAR4_SIG.len() as u64))?;
        return Ok(Some(list_rar4(&mut r, len, cancel)));
    }
    list_zip(&mut r, len, cancel)
}

fn read_up_to(r: &mut impl Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

fn le16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn le32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn le64(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(b.get(at..at + 8)?.try_into().ok()?))
}

fn clean_name(raw: &str) -> String {
    raw.replace('\\', "/").trim_end_matches('/').to_string()
}

fn cancelled(cancel: &AtomicBool, count: usize) -> bool {
    count % 256 == 0 && cancel.load(Ordering::Relaxed)
}

// ── what a scan keeps ─────────────────────────────────────────────────────

/// What a scan remembers about one archive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArchiveInfo {
    pub path: String,
    /// The archive file's own size.
    pub size: u64,
    /// None when the file has a zip or rar name but is neither.
    pub format: Option<ArchiveFormat>,
    pub status: ListStatus,
    /// Files inside (folders not counted).
    pub files: u64,
    /// Their total original size.
    pub unpacked_bytes: u64,
    /// Files whose contents are encrypted (their names were still listed).
    pub encrypted_files: u64,
    /// Zips and rars inside this one. They are listed as files; their own
    /// contents are not read, since that would mean unpacking them.
    pub nested_archives: u64,
    pub solid: bool,
    pub multi_volume: bool,
    /// A hash of every file's size and stored checksum, ignoring names and
    /// order: two archives with the same key hold the same files. None when
    /// any file has no usable checksum, or there are no files.
    pub content_key: Option<String>,
}

/// A file inside an archive that is big enough to be a duplicate worth
/// reporting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchivedFile {
    pub archive: String,
    pub inner: String,
    pub size: u64,
    pub content_key: Option<String>,
}

/// List the archive at `path` (already known to have a zip or rar name) and
/// keep its summary plus the files of at least `min_file` bytes. Errors and
/// damage end up in the summary's status, never as a failure.
pub fn index(
    path: &Path,
    size: u64,
    min_file: u64,
    cancel: &AtomicBool,
) -> (ArchiveInfo, Vec<ArchivedFile>) {
    let path_text = path.to_string_lossy().into_owned();
    let mut info = ArchiveInfo {
        path: path_text.clone(),
        size,
        format: None,
        status: ListStatus::Unreadable,
        files: 0,
        unpacked_bytes: 0,
        encrypted_files: 0,
        nested_archives: 0,
        solid: false,
        multi_volume: false,
        content_key: None,
    };
    let Ok(Some(listing)) = list(path, cancel) else {
        return (info, Vec::new());
    };
    info.format = Some(listing.format);
    info.status = listing.status;
    info.solid = listing.solid;
    info.multi_volume = listing.multi_volume;

    let mut big = Vec::new();
    let mut keys = Vec::new();
    let mut all_keyed = true;
    for e in listing.entries.iter().filter(|e| !e.is_dir) {
        info.files += 1;
        info.unpacked_bytes = info.unpacked_bytes.saturating_add(e.size);
        info.encrypted_files += e.encrypted as u64;
        if is_archive_name(&e.name) {
            info.nested_archives += 1;
        }
        let key = e.content_key();
        match &key {
            Some(k) => keys.push(format!("{}:{k}", e.size)),
            None => all_keyed = false,
        }
        if e.size >= min_file {
            big.push(ArchivedFile {
                archive: path_text.clone(),
                inner: e.name.clone(),
                size: e.size,
                content_key: key,
            });
        }
    }
    if all_keyed && !keys.is_empty() && info.status == ListStatus::Listed {
        use sha2::{Digest, Sha256};
        keys.sort_unstable();
        let mut h = Sha256::new();
        for k in &keys {
            h.update(k.as_bytes());
            h.update(b"\n");
        }
        info.content_key = Some(format!("{:x}", h.finalize()));
    }
    (info, big)
}

// ── zip ────────────────────────────────────────────────────────────────────

const EOCD_SIG: u32 = 0x0605_4b50;
const EOCD64_SIG: u32 = 0x0606_4b50;
const EOCD64_LOCATOR_SIG: u32 = 0x0706_4b50;
const CDH_SIG: u32 = 0x0201_4b50;
/// Precedes a central directory that is itself encrypted (PKWARE's
/// "strong encryption" with masked headers).
const ARCHIVE_EXTRA_SIG: u32 = 0x0806_4b50;

const ZIP_ENCRYPTED: u16 = 0x0001;
const ZIP_UTF8: u16 = 0x0800;
const ZIP_METHOD_AES: u16 = 99;

/// Code page 437, the zip default for names without the UTF-8 flag, for
/// bytes 0x80..=0xFF.
const CP437_HIGH: &str = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u{a0}";

fn decode_cp437(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| {
            if b < 0x80 {
                b as char
            } else {
                CP437_HIGH.chars().nth((b - 0x80) as usize).unwrap_or('?')
            }
        })
        .collect()
}

fn zip_name(raw: &[u8], flags: u16) -> String {
    if flags & ZIP_UTF8 != 0 {
        return String::from_utf8_lossy(raw).into_owned();
    }
    // Many tools write UTF-8 without setting the flag; a name that is valid
    // UTF-8 with non-ASCII bytes almost never is meant as CP437.
    match std::str::from_utf8(raw) {
        Ok(s) => s.to_string(),
        Err(_) => decode_cp437(raw),
    }
}

struct ZipEnd {
    entries: u64,
    cd_size: u64,
    cd_offset: u64,
    /// Where the record that names the central directory sits; the
    /// directory ends right before it.
    record_pos: u64,
    multi_volume: bool,
}

fn find_zip_end<R: Read + Seek>(r: &mut R, len: u64) -> io::Result<Option<ZipEnd>> {
    // The end record is 22 bytes plus a comment of up to 64 KiB.
    let tail_len = len.min(22 + 65_535);
    if tail_len < 22 {
        return Ok(None);
    }
    let tail_start = len - tail_len;
    r.seek(SeekFrom::Start(tail_start))?;
    let mut tail = vec![0u8; tail_len as usize];
    r.read_exact(&mut tail)?;
    let Some(at) = (0..=tail.len() - 22)
        .rev()
        .find(|&i| le32(&tail, i) == Some(EOCD_SIG))
    else {
        return Ok(None);
    };
    let e = &tail[at..];
    let disk = le16(e, 4).unwrap_or(0);
    let mut end = ZipEnd {
        entries: le16(e, 10).unwrap_or(0) as u64,
        cd_size: le32(e, 12).unwrap_or(0) as u64,
        cd_offset: le32(e, 16).unwrap_or(0) as u64,
        record_pos: tail_start + at as u64,
        multi_volume: disk != 0,
    };

    // Zip64: a locator right before the end record points at a bigger one.
    let needs64 =
        end.entries == 0xFFFF || end.cd_size == 0xFFFF_FFFF || end.cd_offset == 0xFFFF_FFFF;
    let locator_pos = end.record_pos.checked_sub(20);
    if let Some(lp) = locator_pos {
        let mut loc = [0u8; 20];
        r.seek(SeekFrom::Start(lp))?;
        if r.read_exact(&mut loc).is_ok() && le32(&loc, 0) == Some(EOCD64_LOCATOR_SIG) {
            // The record's offset is from the start of the zip, which is not
            // the start of the file when something was put in front of it;
            // the record usually sits right before the locator, so try there
            // too.
            let stated = le64(&loc, 8).unwrap_or(u64::MAX);
            for at64 in [stated, lp.saturating_sub(56)] {
                let mut rec = [0u8; 56];
                if at64 < len
                    && r.seek(SeekFrom::Start(at64)).is_ok()
                    && r.read_exact(&mut rec).is_ok()
                    && le32(&rec, 0) == Some(EOCD64_SIG)
                {
                    end.entries = le64(&rec, 32).unwrap_or(end.entries);
                    end.cd_size = le64(&rec, 40).unwrap_or(end.cd_size);
                    end.cd_offset = le64(&rec, 48).unwrap_or(end.cd_offset);
                    end.record_pos = at64;
                    end.multi_volume |= le32(&rec, 16).unwrap_or(0) != 0;
                    return Ok(Some(end));
                }
            }
        }
    }
    if needs64 {
        // Asked for zip64 values but none could be read.
        return Ok(None);
    }
    Ok(Some(end))
}

fn list_zip<R: Read + Seek>(
    r: &mut R,
    len: u64,
    cancel: &AtomicBool,
) -> io::Result<Option<ArchiveListing>> {
    let Some(end) = find_zip_end(r, len)? else {
        return Ok(None);
    };
    let mut out = ArchiveListing::new(ArchiveFormat::Zip);
    out.multi_volume = end.multi_volume;

    // Data in front of the zip (a self-extractor stub) shifts every offset.
    let shift = end
        .record_pos
        .checked_sub(end.cd_size)
        .and_then(|cd_start| cd_start.checked_sub(end.cd_offset))
        .unwrap_or(0);
    let cd_start = end.cd_offset + shift;
    if cd_start >= len && end.entries > 0 {
        out.status = ListStatus::Unreadable;
        return Ok(Some(out));
    }
    r.seek(SeekFrom::Start(cd_start))?;

    let mut fixed = [0u8; 46];
    let mut seen: u64 = 0;
    loop {
        if cancelled(cancel, out.entries.len()) {
            break;
        }
        if read_up_to(r, &mut fixed[..4])? < 4 {
            if seen < end.entries {
                out.status = ListStatus::Unreadable;
            }
            break;
        }
        match le32(&fixed, 0) {
            Some(CDH_SIG) => {}
            Some(ARCHIVE_EXTRA_SIG) if seen == 0 => {
                out.status = ListStatus::Locked;
                break;
            }
            _ => {
                // The directory is over (or garbage where it should be).
                if seen < end.entries {
                    out.status = ListStatus::Unreadable;
                }
                break;
            }
        }
        if read_up_to(r, &mut fixed[4..])? < 42 {
            out.status = ListStatus::Unreadable;
            break;
        }
        let flags = le16(&fixed, 8).unwrap_or(0);
        let method = le16(&fixed, 10).unwrap_or(0);
        let crc = le32(&fixed, 16).unwrap_or(0);
        let mut packed = le32(&fixed, 20).unwrap_or(0) as u64;
        let mut size = le32(&fixed, 24).unwrap_or(0) as u64;
        let name_len = le16(&fixed, 28).unwrap_or(0) as usize;
        let extra_len = le16(&fixed, 30).unwrap_or(0) as usize;
        let comment_len = le16(&fixed, 32).unwrap_or(0) as usize;
        let mut var = vec![0u8; name_len + extra_len];
        if read_up_to(r, &mut var)? < var.len() {
            out.status = ListStatus::Unreadable;
            break;
        }
        r.seek(SeekFrom::Current(comment_len as i64))?;
        let (raw_name, extra) = var.split_at(name_len);

        // Extra fields: zip64 sizes, and the AES record (whose version 2
        // leaves the CRC at 0).
        let mut aes_v2 = false;
        let mut i = 0;
        while i + 4 <= extra.len() {
            let id = le16(extra, i).unwrap_or(0);
            let n = le16(extra, i + 2).unwrap_or(0) as usize;
            let body = extra
                .get(i + 4..(i + 4 + n).min(extra.len()))
                .unwrap_or(&[]);
            match id {
                0x0001 => {
                    let mut at = 0;
                    if size == 0xFFFF_FFFF {
                        size = le64(body, at).unwrap_or(size);
                        at += 8;
                    }
                    if packed == 0xFFFF_FFFF {
                        packed = le64(body, at).unwrap_or(packed);
                    }
                }
                0x9901 => aes_v2 = le16(body, 0) == Some(2),
                _ => {}
            }
            i += 4 + n;
        }

        let name = zip_name(raw_name, flags);
        let is_dir = name.ends_with('/') || name.ends_with('\\');
        let encrypted = flags & ZIP_ENCRYPTED != 0;
        let crc_usable = !is_dir && !(method == ZIP_METHOD_AES && aes_v2);
        seen += 1;
        let entry = ArchiveEntry {
            name: clean_name(&name),
            is_dir,
            size,
            packed,
            crc32: crc_usable.then_some(crc),
            blake2sp: None,
            encrypted,
        };
        if !out.push(entry) {
            break;
        }
    }
    Ok(Some(out))
}

// ── rar 5 ──────────────────────────────────────────────────────────────────

const RAR5_SIG: &[u8] = b"Rar!\x1a\x07\x01\x00";
const RAR4_SIG: &[u8] = b"Rar!\x1a\x07\x00";

fn vint(b: &[u8], pos: &mut usize) -> Option<u64> {
    let mut v: u64 = 0;
    for shift in (0..64).step_by(7) {
        let byte = *b.get(*pos)?;
        *pos += 1;
        v |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some(v);
        }
    }
    None
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

fn list_rar5<R: Read + Seek>(r: &mut R, len: u64, cancel: &AtomicBool) -> ArchiveListing {
    let mut out = ArchiveListing::new(ArchiveFormat::Rar5);
    if let Err(status) = walk_rar5(r, len, cancel, &mut out) {
        if out.status == ListStatus::Listed {
            out.status = status;
        }
    }
    out
}

fn walk_rar5<R: Read + Seek>(
    r: &mut R,
    len: u64,
    cancel: &AtomicBool,
    out: &mut ArchiveListing,
) -> Result<(), ListStatus> {
    let bad = |_| ListStatus::Unreadable;
    let mut pos = RAR5_SIG.len() as u64;
    loop {
        if cancelled(cancel, out.entries.len()) || pos >= len {
            return Ok(());
        }
        r.seek(SeekFrom::Start(pos)).map_err(bad)?;
        // CRC32 (4) then the header size as a vint (up to 3 bytes in
        // practice), then the header itself.
        let mut start = [0u8; 4 + 10];
        let got = read_up_to(r, &mut start).map_err(bad)?;
        let mut p = 4;
        let head = start.get(..got).ok_or(ListStatus::Unreadable)?;
        let size = vint(head, &mut p).ok_or(ListStatus::Unreadable)?;
        if size == 0 || size > MAX_HEADER {
            return Err(ListStatus::Unreadable);
        }
        let header_start = pos + p as u64;
        let mut hdr = vec![0u8; size as usize];
        r.seek(SeekFrom::Start(header_start)).map_err(bad)?;
        r.read_exact(&mut hdr).map_err(bad)?;
        let stored_crc = le32(head, 0).ok_or(ListStatus::Unreadable)?;
        let mut checked = head[4..p].to_vec();
        checked.extend_from_slice(&hdr);
        if crc32(&checked) != stored_crc {
            return Err(ListStatus::Unreadable);
        }

        let mut q = 0;
        let kind = vint(&hdr, &mut q).ok_or(ListStatus::Unreadable)?;
        let hflags = vint(&hdr, &mut q).ok_or(ListStatus::Unreadable)?;
        let extra_size = if hflags & 0x0001 != 0 {
            vint(&hdr, &mut q).ok_or(ListStatus::Unreadable)?
        } else {
            0
        };
        let data_size = if hflags & 0x0002 != 0 {
            vint(&hdr, &mut q).ok_or(ListStatus::Unreadable)?
        } else {
            0
        };
        let next = header_start
            .checked_add(size)
            .and_then(|n| n.checked_add(data_size))
            .ok_or(ListStatus::Unreadable)?;

        match kind {
            // Main archive header.
            1 => {
                let aflags = vint(&hdr, &mut q).unwrap_or(0);
                out.multi_volume = aflags & 0x0001 != 0;
                out.solid = aflags & 0x0004 != 0;
            }
            // File header. (3 is a service header: comments, recovery
            // records; skipped.)
            2 => {
                let split_before = hflags & 0x0008 != 0;
                let split_after = hflags & 0x0010 != 0;
                let entry = rar5_file(&hdr, q, extra_size, data_size, split_after)
                    .ok_or(ListStatus::Unreadable)?;
                // A file continued from the previous part is listed there.
                if !split_before && !out.push(entry) {
                    return Ok(());
                }
            }
            // Archive encryption header: everything after it, names
            // included, is encrypted.
            4 => return Err(ListStatus::Locked),
            // End of archive.
            5 => return Ok(()),
            _ => {}
        }
        if next > len {
            return Err(ListStatus::Unreadable);
        }
        pos = next;
    }
}

fn rar5_file(
    hdr: &[u8],
    mut q: usize,
    extra_size: u64,
    data_size: u64,
    split_after: bool,
) -> Option<ArchiveEntry> {
    let fflags = vint(hdr, &mut q)?;
    let size = vint(hdr, &mut q)?;
    let _attrs = vint(hdr, &mut q)?;
    if fflags & 0x0002 != 0 {
        q += 4; // mtime
    }
    let mut crc = None;
    if fflags & 0x0004 != 0 {
        crc = Some(le32(hdr, q)?);
        q += 4;
    }
    let _compression = vint(hdr, &mut q)?;
    let _host = vint(hdr, &mut q)?;
    let name_len = vint(hdr, &mut q)? as usize;
    let raw_name = hdr.get(q..q.checked_add(name_len)?)?;
    let raw_name = raw_name.split(|&b| b == 0).next().unwrap_or(raw_name);
    let name = String::from_utf8_lossy(raw_name).into_owned();

    let mut encrypted = false;
    let mut tweaked = false;
    let mut link = false;
    let mut blake = None;
    let extra_start = hdr.len().checked_sub(extra_size as usize)?;
    let extra = &hdr[extra_start..];
    let mut i = 0;
    while i < extra.len() {
        let Some(rec_size) = vint(extra, &mut i) else {
            break;
        };
        let rec_end = i.checked_add(rec_size as usize)?.min(extra.len());
        let rec = &extra[i..rec_end];
        let mut k = 0;
        match vint(rec, &mut k) {
            // File encryption record: version, flags (2 = tweaked checksums).
            Some(1) => {
                encrypted = true;
                let _version = vint(rec, &mut k);
                tweaked = vint(rec, &mut k).unwrap_or(0) & 0x0002 != 0;
            }
            // File hash record; type 0 is BLAKE2sp.
            Some(2) => {
                if vint(rec, &mut k) == Some(0) {
                    if let Some(h) = rec.get(k..k + 32) {
                        blake = Some(h.iter().map(|b| format!("{b:02x}")).collect());
                    }
                }
            }
            // Redirection: a symlink, hard link or "file copy" whose stored
            // data is a reference, not the file's bytes.
            Some(5) => link = true,
            _ => {}
        }
        i = rec_end;
    }
    // A tweaked checksum is mixed with the password, so it says nothing
    // about the contents; a split file's checksum covers only this part.
    let usable = !tweaked && !split_after && !link;
    let is_dir = fflags & 0x0001 != 0;
    Some(ArchiveEntry {
        name: clean_name(&name),
        is_dir,
        size: if fflags & 0x0008 != 0 { 0 } else { size },
        packed: data_size,
        crc32: if usable && !is_dir { crc } else { None },
        blake2sp: if usable { blake } else { None },
        encrypted,
    })
}

// ── rar 1.5 to 4.x ─────────────────────────────────────────────────────────

const RAR4_MAIN: u8 = 0x73;
const RAR4_FILE: u8 = 0x74;
const RAR4_END: u8 = 0x7b;
const RAR4_LONG_BLOCK: u16 = 0x8000;

fn list_rar4<R: Read + Seek>(r: &mut R, len: u64, cancel: &AtomicBool) -> ArchiveListing {
    let mut out = ArchiveListing::new(ArchiveFormat::Rar4);
    if let Err(status) = walk_rar4(r, len, cancel, &mut out) {
        if out.status == ListStatus::Listed {
            out.status = status;
        }
    }
    out
}

fn walk_rar4<R: Read + Seek>(
    r: &mut R,
    len: u64,
    cancel: &AtomicBool,
    out: &mut ArchiveListing,
) -> Result<(), ListStatus> {
    let bad = |_| ListStatus::Unreadable;
    let mut pos = RAR4_SIG.len() as u64;
    loop {
        if cancelled(cancel, out.entries.len()) || pos + 7 > len {
            return Ok(());
        }
        r.seek(SeekFrom::Start(pos)).map_err(bad)?;
        let mut base = [0u8; 7];
        r.read_exact(&mut base).map_err(bad)?;
        let kind = base[2];
        let flags = le16(&base, 3).unwrap_or(0);
        let head_size = le16(&base, 5).unwrap_or(0) as u64;
        if head_size < 7 {
            return Err(ListStatus::Unreadable);
        }
        let mut hdr = vec![0u8; head_size as usize];
        hdr[..7].copy_from_slice(&base);
        r.read_exact(&mut hdr[7..]).map_err(bad)?;
        let add_size = if flags & RAR4_LONG_BLOCK != 0 {
            le32(&hdr, 7).ok_or(ListStatus::Unreadable)? as u64
        } else {
            0
        };

        match kind {
            RAR4_MAIN => {
                out.multi_volume = flags & 0x0001 != 0;
                out.solid = flags & 0x0008 != 0;
                // Encrypted headers: everything after this is unreadable
                // without the password.
                if flags & 0x0080 != 0 {
                    return Err(ListStatus::Locked);
                }
            }
            RAR4_FILE => {
                let (entry, packed) = rar4_file(&hdr, flags).ok_or(ListStatus::Unreadable)?;
                pos = pos
                    .checked_add(head_size)
                    .and_then(|p| p.checked_add(packed))
                    .ok_or(ListStatus::Unreadable)?;
                // Continued from the previous part: listed there.
                if flags & 0x0001 == 0 && !out.push(entry) {
                    return Ok(());
                }
                continue;
            }
            RAR4_END => return Ok(()),
            _ => {}
        }
        pos += head_size + add_size;
    }
}

/// A rar 4 file header: the entry and the packed size to skip over.
fn rar4_file(hdr: &[u8], flags: u16) -> Option<(ArchiveEntry, u64)> {
    let mut packed = le32(hdr, 7)? as u64;
    let mut size = le32(hdr, 11)? as u64;
    let crc = le32(hdr, 16)?;
    let name_len = le16(hdr, 26)? as usize;
    let mut at = 32;
    if flags & 0x0100 != 0 {
        packed |= (le32(hdr, at)? as u64) << 32;
        size |= (le32(hdr, at + 4)? as u64) << 32;
        at += 8;
    }
    let raw = hdr.get(at..at.checked_add(name_len)?)?;
    let name = if flags & 0x0200 != 0 {
        match raw.iter().position(|&b| b == 0) {
            Some(nul) => decode_rar_unicode(&raw[..nul], &raw[nul + 1..])
                .unwrap_or_else(|| decode_cp437(&raw[..nul])),
            None => String::from_utf8_lossy(raw).into_owned(),
        }
    } else {
        let raw = raw.split(|&b| b == 0).next().unwrap_or(raw);
        match std::str::from_utf8(raw) {
            Ok(s) => s.to_string(),
            Err(_) => decode_cp437(raw),
        }
    };
    let is_dir = flags & 0x00e0 == 0x00e0;
    let split_after = flags & 0x0002 != 0;
    Some((
        ArchiveEntry {
            name: clean_name(&name),
            is_dir,
            size: if is_dir { 0 } else { size },
            packed,
            // Rar 4 stores the CRC of the original bytes even for encrypted
            // files; a file split across parts has only this part's CRC.
            crc32: (!is_dir && !split_after).then_some(crc),
            blake2sp: None,
            encrypted: flags & 0x0004 != 0,
        },
        packed,
    ))
}

/// Rar 3's compressed UTF-16 file names: the 8-bit name, a NUL, then this
/// encoding of the real name against it.
fn decode_rar_unicode(std_name: &[u8], enc: &[u8]) -> Option<String> {
    fn take(enc: &[u8], e: &mut usize) -> Option<u8> {
        let b = enc.get(*e).copied();
        *e += 1;
        b
    }
    let mut out: Vec<u16> = Vec::new();
    let mut e = 0usize;
    let hi = take(enc, &mut e)? as u16;
    let mut flags = 0u8;
    let mut flagbits = 0;
    while e < enc.len() {
        if flagbits == 0 {
            flags = take(enc, &mut e)?;
            flagbits = 8;
        }
        flagbits -= 2;
        match (flags >> flagbits) & 3 {
            0 => out.push(take(enc, &mut e)? as u16),
            1 => out.push((hi << 8) | take(enc, &mut e)? as u16),
            2 => {
                let lo = take(enc, &mut e)? as u16;
                let h = take(enc, &mut e)? as u16;
                out.push((h << 8) | lo);
            }
            _ => {
                let n = take(enc, &mut e)?;
                if n & 0x80 != 0 {
                    let c = take(enc, &mut e)?;
                    for _ in 0..(n & 0x7f) as usize + 2 {
                        let s = *std_name.get(out.len())?;
                        out.push((hi << 8) | s.wrapping_add(c) as u16);
                    }
                } else {
                    for _ in 0..n as usize + 2 {
                        out.push(*std_name.get(out.len())? as u16);
                    }
                }
            }
        }
    }
    Some(String::from_utf16_lossy(&out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_matches_the_standard_check_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn kind_by_extension() {
        assert!(is_archive_name("a.ZIP"));
        assert!(is_archive_name("comic.cbr"));
        assert!(!is_archive_name("a.zip.txt"));
        assert!(!is_archive_name("zip"));
        assert!(!is_archive_name("report.docx"));
    }

    #[test]
    fn cp437_names() {
        assert_eq!(decode_cp437(b"caf\x82"), "café");
        assert_eq!(zip_name(b"caf\x82", 0), "café");
        assert_eq!(zip_name("café".as_bytes(), 0), "café");
    }
}
