# Putting Wikipedia on your USB stick

Verity reads Kiwix `.zim` archives directly. Plug the drive in and it is detected
automatically — there is nothing to configure.

## Which archive to download

Verity only ever reads **article text**. It never displays images, so the
picture-bearing archives cost you tens of gigabytes for nothing. Pick from the
`nopic` family unless you want to browse the same archive in Kiwix yourself.

| Archive | Size | What you get |
|---|---|---|
| `wikipedia_en_all_nopic` | **49 GB** | Every English article, full text. **Recommended.** |
| `wikipedia_en_all_mini` | 12 GB | Every article, but only the intro section of each |
| `wikipedia_en_top_nopic` | 2.1 GB | The 50,000 most-read articles, full text |
| `wikipedia_en_simple_all_nopic` | 937 MB | Simple English Wikipedia, full text |
| `wikipedia_en_all_maxi` | 115 GB | Everything including images — wasted on Verity |

`all_nopic` is the one to get if the drive has room: "full text of everything" is
exactly what makes Verity's factual answers trustworthy. `all_mini` sounds like a
reasonable compromise but is not — it truncates every article to its lead
paragraph, so anything specific gets a shrug.

## Format the drive first

**This matters.** These files are far larger than 4 GB, and a FAT32 drive cannot
store a single file over 4 GB. A stick formatted at the factory is usually FAT32
and the copy will fail partway through.

Format as **exFAT** (readable on Macs, Windows and Linux) or **APFS** if the drive
will only ever be used with a Mac:

1. Open Disk Utility
2. View › Show All Devices, then select the **drive**, not the volume beneath it
3. Erase → Format: **exFAT**, Scheme: **GUID Partition Map**

Check what you have with:

```bash
diskutil info /Volumes/YOUR_DRIVE | grep "File System"
```

## Download it

Straight onto the drive, so it is never on your internal disk:

```bash
cd /Volumes/YOUR_DRIVE && curl -L -O -C - https://download.kiwix.org/zim/wikipedia/wikipedia_en_all_nopic_2026-06.zim
```

`-C -` resumes an interrupted transfer. A 49 GB download will take hours; if it
drops, run the identical command again and it continues where it stopped.

Check the current filename first, since Kiwix reissues these monthly and removes
old ones:

```bash
curl -s https://download.kiwix.org/zim/wikipedia/ | grep -o 'wikipedia_en_all_nopic_[0-9-]*\.zim' | sort -u | tail -1
```

## Verify it

```bash
npm run check-wikipedia
```

That opens the archive, prints its title and article count, and runs a sample
lookup. If it reports the entry count and returns an article, Verity will work
with it.

## Where Verity looks

Every `.zim` under any of these, plus `zim/`, `kiwix/` and `Wikipedia/`
subfolders inside them:

- `/Volumes` — any mounted USB drive
- `~/Documents`
- `~/Downloads`

With more than one archive present, the largest wins. Settings shows which is
active.

## Compression note

Verity reads `zstd`-compressed archives, which is what Kiwix has published since
2021. A pre-2021 archive using LZMA will be rejected with a clear message rather
than failing strangely — download a current one.

## When the drive is unplugged

Verity notices and tells the model the archive is gone. It will say it cannot
look something up rather than inventing an answer. Weather and anything else
needing the network keep working normally, since those never used the drive.
