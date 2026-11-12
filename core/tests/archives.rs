//! Reading inside zip and rar archives: listing, locked archives, and what
//! scans and findings make of them.
//!
//! The .rar files under fixtures/archives come from the rarfile project's
//! test suite (ISC license, see RARFILE-LICENSE there), since this machine
//! can't make rar archives. zipcrypto.zip was made with Info-ZIP's
//! `zip -P secret`. Other zips are built byte by byte below.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use disk_core::analyzer::Analyzer;
use disk_core::archives::{self, ArchiveFormat, ListStatus};
use disk_core::model::Finding;
use disk_core::scanner;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/archives")
        .join(name)
}

fn list(path: &Path) -> archives::ArchiveListing {
    archives::list(path, &AtomicBool::new(false))
        .expect("readable file")
        .expect("an archive")
}

fn files(l: &archives::ArchiveListing) -> Vec<(&str, u64, Option<u32>, bool)> {
    l.entries
        .iter()
        .filter(|e| !e.is_dir)
        .map(|e| (e.name.as_str(), e.size, e.crc32, e.encrypted))
        .collect()
}

// ── a tiny zip writer (stored entries only) ────────────────────────────────

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xEDB8_8320 & (crc & 1).wrapping_neg());
        }
    }
    !crc
}

#[derive(Clone)]
struct ZipEntry {
    name: String,
    data: Vec<u8>,
    flags: u16,
    method: u16,
    /// CRC to write instead of the real one (AES v2 writes 0).
    crc: Option<u32>,
    extra: Vec<u8>,
}

fn entry(name: &str, data: &[u8]) -> ZipEntry {
    ZipEntry {
        name: name.into(),
        data: data.to_vec(),
        flags: 0x0800,
        method: 0,
        crc: None,
        extra: Vec::new(),
    }
}

/// A zip of stored entries. `prefix` goes in front (a self-extractor stub);
/// `zip64` writes the zip64 end records with the classic one masked.
fn build_zip(entries: &[ZipEntry], prefix: &[u8], zip64: bool, comment: &[u8]) -> Vec<u8> {
    let mut out = prefix.to_vec();
    let mut central = Vec::new();
    for e in entries {
        let offset = (out.len() - prefix.len()) as u32;
        let crc = e.crc.unwrap_or_else(|| crc32(&e.data));
        let n = e.data.len() as u32;
        let mut common = Vec::new();
        common.extend_from_slice(&20u16.to_le_bytes()); // version needed
        common.extend_from_slice(&e.flags.to_le_bytes());
        common.extend_from_slice(&e.method.to_le_bytes());
        common.extend_from_slice(&[0, 0, 0x21, 0]); // time, date
        common.extend_from_slice(&crc.to_le_bytes());
        common.extend_from_slice(&n.to_le_bytes());
        common.extend_from_slice(&n.to_le_bytes());
        common.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
        common.extend_from_slice(&(e.extra.len() as u16).to_le_bytes());

        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&common);
        out.extend_from_slice(e.name.as_bytes());
        out.extend_from_slice(&e.extra);
        out.extend_from_slice(&e.data);

        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central.extend_from_slice(&common);
        central.extend_from_slice(&[0; 10]); // comment length, disk, attributes
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(e.name.as_bytes());
        central.extend_from_slice(&e.extra);
    }
    let cd_offset = (out.len() - prefix.len()) as u64;
    let cd_size = central.len() as u64;
    out.extend_from_slice(&central);
    let count = entries.len() as u64;
    if zip64 {
        let at = (out.len() - prefix.len()) as u64;
        out.extend_from_slice(&0x0606_4b50u32.to_le_bytes());
        out.extend_from_slice(&44u64.to_le_bytes());
        out.extend_from_slice(&[45, 0, 45, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&cd_size.to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&0x0706_4b50u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        // Offset from the start of the zip, as real tools write it.
        out.extend_from_slice(&at.to_le_bytes());
        out.extend_from_slice(&1u32.to_le_bytes());
    }
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    let (c16, size32, off32) = if zip64 {
        (0xFFFF, 0xFFFF_FFFF, 0xFFFF_FFFF)
    } else {
        (count as u16, cd_size as u32, cd_offset as u32)
    };
    out.extend_from_slice(&c16.to_le_bytes());
    out.extend_from_slice(&c16.to_le_bytes());
    out.extend_from_slice(&size32.to_le_bytes());
    out.extend_from_slice(&off32.to_le_bytes());
    out.extend_from_slice(&(comment.len() as u16).to_le_bytes());
    out.extend_from_slice(comment);
    out
}

fn write_zip(path: &Path, entries: &[ZipEntry]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, build_zip(entries, &[], false, &[])).unwrap();
}

/// Bytes that won't compress or collide, `len` long, distinct per seed.
fn noise(seed: u64, len: usize) -> Vec<u8> {
    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x as u8
        })
        .collect()
}

// ── zip ────────────────────────────────────────────────────────────────────

#[test]
fn lists_a_zip_with_names_sizes_and_crcs() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a.zip");
    write_zip(
        &path,
        &[
            entry("docs/", b""),
            entry("docs/one.txt", b"hello"),
            entry("two.bin", b"12345678"),
        ],
    );
    let l = list(&path);
    assert_eq!(l.format, ArchiveFormat::Zip);
    assert_eq!(l.status, ListStatus::Listed);
    assert_eq!(l.entries.len(), 3);
    assert!(l.entries[0].is_dir && l.entries[0].name == "docs");
    assert_eq!(
        files(&l),
        vec![
            ("docs/one.txt", 5, Some(crc32(b"hello")), false),
            ("two.bin", 8, Some(crc32(b"12345678")), false),
        ]
    );
}

#[test]
fn a_password_zip_still_lists_names_and_sizes_without_asking() {
    // Info-ZIP's classic encryption hides the contents, not the names.
    let l = list(&fixture("zipcrypto.zip"));
    assert_eq!(l.status, ListStatus::Listed);
    let mut f = files(&l);
    f.sort();
    assert_eq!(
        f,
        vec![
            ("café.txt", 3, Some(crc32(b"caf")), true),
            ("sub/a.txt", 3, Some(crc32(b"hi\n")), true),
        ]
    );
}

#[test]
fn an_aes_zip_entry_has_no_usable_crc() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("aes.zip");
    // AE-2: method 99, CRC written as 0, extra record 0x9901 version 2.
    let mut e = entry("secret.txt", b"0123456789");
    e.flags |= 1;
    e.method = 99;
    e.crc = Some(0);
    e.extra = vec![0x01, 0x99, 7, 0, 2, 0, b'A', b'E', 3, 8, 0];
    write_zip(&path, &[e]);
    let l = list(&path);
    assert_eq!(files(&l), vec![("secret.txt", 10, None, true)]);
}

#[test]
fn a_zip_with_an_encrypted_directory_is_locked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("masked.zip");
    // Strong encryption with masked headers: an "archive extra data" record
    // sits where the directory would start, and the counts are hidden.
    let mut bytes = b"PK\x03\x04garbage".to_vec();
    let cd_at = bytes.len() as u32;
    bytes.extend_from_slice(&0x0806_4b50u32.to_le_bytes());
    bytes.extend_from_slice(&[4, 0, 0, 0, 1, 2, 3, 4]);
    let cd_size = (bytes.len() as u32) - cd_at;
    bytes.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    bytes.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0]);
    bytes.extend_from_slice(&cd_size.to_le_bytes());
    bytes.extend_from_slice(&cd_at.to_le_bytes());
    bytes.extend_from_slice(&[0, 0]);
    fs::write(&path, bytes).unwrap();
    let l = list(&path);
    assert_eq!(l.status, ListStatus::Locked);
    assert!(l.entries.is_empty());
}

#[test]
fn zip64_self_extracting_and_commented_zips() {
    let dir = tempfile::tempdir().unwrap();
    let entries = [entry("x.txt", b"abc"), entry("y.txt", b"defg")];
    for (name, bytes) in [
        ("z64.zip", build_zip(&entries, &[], true, &[])),
        (
            "sfx.zip",
            build_zip(&entries, &noise(1, 3000), false, b"a comment"),
        ),
        ("both.zip", build_zip(&entries, &noise(2, 100), true, b"c")),
    ] {
        let path = dir.path().join(name);
        fs::write(&path, bytes).unwrap();
        let l = list(&path);
        assert_eq!(l.status, ListStatus::Listed, "{name}");
        assert_eq!(files(&l).len(), 2, "{name}");
        assert_eq!(l.entries[1].name, "y.txt", "{name}");
    }
}

#[test]
fn a_cut_short_or_fake_zip_is_not_an_archive() {
    let dir = tempfile::tempdir().unwrap();
    let real = build_zip(&[entry("x.txt", b"abc")], &[], false, &[]);
    let cut = dir.path().join("cut.zip");
    fs::write(&cut, &real[..real.len() - 30]).unwrap();
    let fake = dir.path().join("fake.zip");
    fs::write(&fake, b"not a zip at all").unwrap();
    let never = AtomicBool::new(false);
    assert!(archives::list(&cut, &never).unwrap().is_none());
    assert!(archives::list(&fake, &never).unwrap().is_none());
}

// ── rar ────────────────────────────────────────────────────────────────────

#[test]
fn lists_rar5_and_rar4() {
    let l = list(&fixture("rar5-crc.rar"));
    assert_eq!(
        (l.format, l.status),
        (ArchiveFormat::Rar5, ListStatus::Listed)
    );
    assert_eq!(
        files(&l),
        vec![
            ("stest1.txt", 2048, Some(0xc5b7e6a2), false),
            ("stest2.txt", 2048, Some(0xc5b7e6a2), false),
        ]
    );

    let l = list(&fixture("rar3-subdirs.rar"));
    assert_eq!(
        (l.format, l.status),
        (ArchiveFormat::Rar4, ListStatus::Listed)
    );
    let names: Vec<&str> = files(&l).iter().map(|f| f.0).collect();
    assert_eq!(
        names,
        vec![
            "sub/dir2/file2.txt",
            "sub/with space/long fn.txt",
            "sub/üȵĩöḋè/file.txt",
            "sub/dir1/file1.txt",
        ]
    );
    assert_eq!(l.entries.iter().filter(|e| e.is_dir).count(), 6);
}

#[test]
fn rar5_blake2_hashes_are_kept() {
    let l = list(&fixture("rar5-blake.rar"));
    let e = &l.entries[0];
    assert_eq!(e.crc32, None);
    assert_eq!(e.blake2sp.as_deref().map(str::len), Some(64));
    assert_eq!(l.entries[0].content_key(), l.entries[1].content_key());
}

#[test]
fn solid_rars_list_like_any_other() {
    for name in ["rar3-solid.rar", "rar5-solid.rar"] {
        let l = list(&fixture(name));
        assert!(l.solid, "{name}");
        assert_eq!(l.status, ListStatus::Listed);
        assert_eq!(files(&l).len(), 2, "{name}");
    }
}

#[test]
fn rar_with_encrypted_contents_lists_names() {
    // Rar 4 keeps the real CRC of encrypted files; rar 5's "tweaked"
    // checksum depends on the password, so it is dropped.
    let l = list(&fixture("rar3-comment-psw.rar"));
    assert_eq!(l.status, ListStatus::Listed);
    assert!(l.entries.iter().all(|e| e.encrypted));

    let l = list(&fixture("rar5-psw.rar"));
    assert_eq!(l.status, ListStatus::Listed);
    assert_eq!(
        files(&l),
        vec![
            ("stest1.txt", 2048, None, true),
            ("stest2.txt", 2048, None, true)
        ]
    );
}

#[test]
fn rar_with_encrypted_names_is_locked_not_a_prompt() {
    for name in ["rar5-hpsw.rar", "rar3-comment-hpsw.rar"] {
        let l = list(&fixture(name));
        assert_eq!(l.status, ListStatus::Locked, "{name}");
        assert!(l.entries.is_empty(), "{name}");
    }
}

#[test]
fn rar5_links_and_file_copies_have_no_content_checksum() {
    // stest2..9 are rar's "file copy" references to stest1.
    let l = list(&fixture("rar5-dups.rar"));
    assert_eq!(l.entries.len(), 9);
    assert!(l.entries[0].crc32.is_some());
    assert!(l.entries[1..].iter().all(|e| e.content_key().is_none()));
}

// ── scans and findings ─────────────────────────────────────────────────────

fn scan(root: &Path) -> (scanner::ScanData, Vec<Finding>) {
    let data = scanner::scan(root, &AtomicBool::new(false), |_| {}).unwrap();
    let findings = Analyzer::new(&data).analyze();
    (data, findings)
}

fn by_category<'a>(findings: &'a [Finding], category: &str) -> Vec<&'a Finding> {
    findings.iter().filter(|f| f.category == category).collect()
}

const MB: usize = 1024 * 1024;

#[test]
fn a_scan_lists_archives_without_counting_their_contents_as_disk_use() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_zip(
        &root.join("a.zip"),
        &[entry("x.txt", b"abc"), entry("y.txt", b"de")],
    );
    fs::copy(fixture("rar5-hpsw.rar"), root.join("locked.rar")).unwrap();
    fs::write(root.join("broken.zip"), b"nope").unwrap();
    fs::copy(fixture("rar5-crc.rar"), root.join("comic.cbr")).unwrap();

    let (data, findings) = scan(root);
    assert_eq!(
        data.total_files, 4,
        "archive contents are not files on disk"
    );
    assert_eq!(data.archives.len(), 4);
    let get = |n: &str| data.archives.iter().find(|a| a.path.ends_with(n)).unwrap();
    assert_eq!(get("a.zip").status, ListStatus::Listed);
    assert_eq!(get("a.zip").files, 2);
    assert_eq!(get("a.zip").unpacked_bytes, 5);
    assert_eq!(get("locked.rar").status, ListStatus::Locked);
    assert_eq!(get("broken.zip").status, ListStatus::Unreadable);
    assert_eq!(get("broken.zip").format, None);
    assert_eq!(get("comic.cbr").format, Some(ArchiveFormat::Rar5));

    let locked = by_category(&findings, "locked_archive");
    assert_eq!(locked.len(), 1);
    assert!(locked[0].paths[0].ends_with("locked.rar"));
    assert!(locked[0].reason.contains("No password was asked for"));
    assert_eq!(by_category(&findings, "unreadable_archive").len(), 1);
}

#[test]
fn files_inside_archives_join_duplicate_detection() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let movie = noise(7, 2 * MB);
    fs::create_dir(root.join("videos")).unwrap();
    fs::write(root.join("videos/clip.mov"), &movie).unwrap();
    write_zip(&root.join("backup.zip"), &[entry("old/clip.mov", &movie)]);

    let (_, findings) = scan(root);
    let dups = by_category(&findings, "duplicate_file_candidate");
    let clip = dups
        .iter()
        .find(|f| f.reason.contains("'clip.mov'"))
        .expect("the loose clip and the zipped one");
    assert_eq!(clip.paths.len(), 2);
    assert!(clip
        .paths
        .iter()
        .any(|p| p.ends_with("backup.zip › old/clip.mov")));
    assert!(clip.reason.contains("1 inside archives"));
    // Removing the loose copy frees its size; the zipped one stays.
    assert_eq!(clip.total_bytes, movie.len() as u64);
}

#[test]
fn archived_copies_with_different_checksums_are_not_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_zip(&root.join("a.zip"), &[entry("data.bin", &noise(1, 2 * MB))]);
    write_zip(&root.join("b.zip"), &[entry("data.bin", &noise(2, 2 * MB))]);
    write_zip(&root.join("c.zip"), &[entry("data.bin", &noise(1, 2 * MB))]);

    let (_, findings) = scan(root);
    let dups: Vec<_> = by_category(&findings, "duplicate_file_candidate")
        .into_iter()
        .filter(|f| f.reason.contains("'data.bin'"))
        .collect();
    assert_eq!(dups.len(), 1);
    let mut names: Vec<_> = dups[0]
        .paths
        .iter()
        .map(|p| p.rsplit('/').next().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, vec!["a.zip › data.bin", "c.zip › data.bin"]);
    assert!(dups[0].reason.contains("stored checksums match"));
    // Both copies are inside archives: nothing frees space by itself.
    assert_eq!(dups[0].total_bytes, 0);
}

#[test]
fn archives_with_the_same_files_are_flagged_even_when_their_bytes_differ() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let a = noise(3, 2 * MB);
    let b = noise(4, 600 * 1024);
    write_zip(
        &root.join("photos-2019.zip"),
        &[entry("a.jpg", &a), entry("b.jpg", &b)],
    );
    // Same files, other names and order, plus a comment: different bytes.
    fs::create_dir(root.join("old")).unwrap();
    fs::write(
        root.join("old/photos copy.zip"),
        build_zip(
            &[entry("pics/b.jpg", &b), entry("pics/a.jpg", &a)],
            &[],
            false,
            b"copy",
        ),
    )
    .unwrap();
    write_zip(&root.join("other.zip"), &[entry("a.jpg", &a)]);

    let (_, findings) = scan(root);
    let same = by_category(&findings, "duplicate_archive_candidate");
    assert_eq!(same.len(), 1);
    assert_eq!(same[0].paths.len(), 2);
    assert!(same[0].reason.contains("same 2 files"));
    assert!(same[0].total_bytes > 0);
}

#[test]
fn an_archive_next_to_its_extracted_folder() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let files: Vec<(String, Vec<u8>)> = (0..5)
        .map(|i| (format!("track{i}.flac"), noise(10 + i, 400 * 1024)))
        .collect();
    let entries: Vec<ZipEntry> = files.iter().map(|(n, d)| entry(n, d)).collect();
    write_zip(&root.join("album.zip"), &entries);
    fs::create_dir(root.join("album")).unwrap();
    for (n, d) in &files {
        fs::write(root.join("album").join(n), d).unwrap();
    }
    // A folder with the name but other contents is not a match.
    write_zip(&root.join("misc.zip"), &entries);
    fs::create_dir(root.join("misc")).unwrap();
    fs::write(root.join("misc/notes.txt"), b"x").unwrap();

    let (_, findings) = scan(root);
    let ex = by_category(&findings, "extracted_archive_candidate");
    assert_eq!(ex.len(), 1);
    assert!(ex[0].paths[0].ends_with("album.zip"));
    assert!(ex[0].paths[1].ends_with("album"));
}

#[test]
fn damaged_archives_never_panic() {
    // Every prefix of every fixture, and each with one byte flipped at
    // several places: listing may fail, but must not panic or hang.
    let dir = tempfile::tempdir().unwrap();
    let mut samples: Vec<Vec<u8>> = fs::read_dir(fixture(""))
        .unwrap()
        .flatten()
        .filter(|e| archives::is_archive_name(&e.file_name().to_string_lossy()))
        .map(|e| fs::read(e.path()).unwrap())
        .collect();
    samples.push(build_zip(
        &[entry("x.txt", b"abc")],
        &noise(5, 50),
        true,
        b"c",
    ));
    let never = AtomicBool::new(false);
    let path = dir.path().join("t.rar");
    for bytes in &samples {
        let step = (bytes.len() / 97).max(1);
        for cut in (0..bytes.len()).step_by(step) {
            fs::write(&path, &bytes[..cut]).unwrap();
            let _ = archives::list(&path, &never);
            let mut flipped = bytes.clone();
            flipped[cut] ^= 0xA5;
            fs::write(&path, &flipped).unwrap();
            let _ = archives::list(&path, &never);
        }
    }
}
