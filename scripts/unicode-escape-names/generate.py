"""Regenerate the offline Python 3.12 / UCD 15.0 named-escape and repr-printability tables.

Run with an existing Python 3.12 interpreter:
  python scripts/unicode-escape-names/generate.py [--check]
No network, package installation or host-ICU dependency is used.
Inputs, exact official URLs, hashes and license are beside this script.
"""
from pathlib import Path
import argparse
import ast
import gzip
import hashlib
import json
import sys
import unicodedata

VERSION = '15.0.0'
ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUTPUT = ROOT / 'src/scheduler/unicodeEscapeNamesData.ts'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def load_sources():
    manifest = json.loads((HERE / 'sources.json').read_text('utf-8'))
    assert manifest['unicodeVersion'] == VERSION
    raw = {}
    for filename, entry in manifest['files'].items():
        data = (HERE / filename).read_bytes()
        if filename.endswith('.gz'):
            data = gzip.decompress(data)
        if digest(data) != entry['sha256']:
            raise ValueError(f'Source hash mismatch: {filename}')
        raw[filename] = data.decode('utf-8')
    return raw


def literal(name):
    return ast.literal_eval("'" + chr(92) + 'N{' + name + '}' + "'")


def build():
    if sys.version_info[:2] != (3, 12) or unicodedata.unidata_version != VERSION:
        raise RuntimeError('Generation requires Python 3.12 with Unicode 15.0.0')
    source = load_sources()
    canonical, cjk_ranges = {}, []
    first = None
    for line in source['UnicodeData-15.0.0.txt.gz'].splitlines():
        fields = line.split(';')
        code, name = int(fields[0], 16), fields[1]
        if name.startswith('<CJK Ideograph'):
            if name.endswith(', First>'):
                first = code
            elif name.endswith(', Last>'):
                assert first is not None
                cjk_ranges.append([first, code])
                first = None
        if not name.startswith('<'):
            canonical[name] = code
    assert len(canonical) == 34823 and len(cjk_ranges) == 9
    native = {}
    canonical_count, cjk_count, hangul_count = 0, 0, 0
    printable_ranges, printable_start, printable_count = [], None, 0
    for code in range(0x110000):
        printable = chr(code).isprintable()
        assert printable == (code == 0x20 or unicodedata.category(chr(code))[0] not in 'CZ')
        if printable:
            printable_count += 1
            if printable_start is None:
                printable_start = code
        elif printable_start is not None:
            printable_ranges.append([printable_start, code - 1])
            printable_start = None
        name = unicodedata.name(chr(code), '')
        if not name:
            continue
        canonical_count += 1
        if name.startswith('CJK UNIFIED IDEOGRAPH-'):
            assert any(start <= code <= end for start, end in cjk_ranges)
            cjk_count += 1
        elif name.startswith('HANGUL SYLLABLE '):
            assert 0xac00 <= code <= 0xd7a3
            hangul_count += 1
        else:
            native[name] = code
        # This is the actual literal escape contract, not the wider lookup API.
        assert literal(name) == chr(code)
    assert printable_start is None
    assert native == canonical, 'Official canonical names differ from Python 3.12'
    assert cjk_count == sum(end - start + 1 for start, end in cjk_ranges)
    assert hangul_count == 11172
    entries = dict(canonical)
    aliases = 0
    for line in source['NameAliases-15.0.0.txt'].splitlines():
        row = line.split('#')[0].strip()
        if not row:
            continue
        hex_code, name, _kind = row.split(';')
        code = int(hex_code, 16)
        assert name not in entries
        assert unicodedata.lookup(name) == literal(name) == chr(code)
        entries[name] = code
        aliases += 1
    assert aliases == 473 and len(entries) == 35296
    sequences = 0
    for line in source['NamedSequences-15.0.0.txt'].splitlines():
        row = line.split('#')[0].strip()
        if not row:
            continue
        name, codes = row.split(';')
        assert unicodedata.lookup(name) == ''.join(chr(int(code, 16)) for code in codes.split())
        try:
            literal(name)
        except SyntaxError:
            pass
        else:
            raise AssertionError(f'Named sequence unexpectedly valid in a literal: {name}')
        assert name not in entries
        sequences += 1
    assert sequences == 461
    previous, rows = '', []
    for name, code in sorted(entries.items()):
        assert name.isascii() and name == name.upper()
        assert not any(char in name for char in (';', ':', '`', chr(92)))
        prefix = 0
        while prefix < min(len(previous), len(name)) and previous[prefix] == name[prefix]:
            prefix += 1
        rows.append(f'{prefix}:{name[prefix:]};{code:X}')
        previous = name
    packed = chr(10).join(rows)
    license_text = source['LICENSE.txt'].strip()
    text = (
        '/*!\n' + license_text + '\n*/\n'
        '// Generated by scripts/unicode-escape-names/generate.py; do not hand edit.\n'
        '// Python 3.12 / Unicode 15.0.0: literal names, formal aliases and repr printability.\n'
        "export const BACKUP_UNICODE_VERSION='15.0.0'\n"
        'export const CJK_UNIFIED_RANGES=' + json.dumps(cjk_ranges, separators=(',', ':')) + ' as const\n'
        'export const UNICODE_PRINTABLE_RANGES=' + json.dumps(printable_ranges, separators=(',', ':')) + ' as const\n'
        '// Each row is decimal shared-prefix length : name suffix ; hexadecimal code point.\n'
        'export const UNICODE_NAME_TABLE=`' + packed + '`\n'
    ).encode('utf-8')
    return text, {
        'python': sys.version,
        'unicodeVersion': VERSION,
        'canonicalNames': canonical_count,
        'explicitCanonicalNames': len(canonical),
        'aliases': aliases,
        'tableEntries': len(entries),
        'cjkAlgorithmicNames': cjk_count,
        'hangulAlgorithmicNames': hangul_count,
        'namedSequencesRejected': sequences,
        'singleCodepointLiteralChecks': canonical_count + aliases,
        'printabilityCodePointsChecked': 0x110000,
        'printableCodePoints': printable_count,
        'printableRanges': len(printable_ranges),
        'printableRangeDataBytes': len(json.dumps(printable_ranges, separators=(',', ':')).encode('ascii')),
        'nameTableSha256': digest(packed.encode('ascii')),
        'packedBytes': len(packed.encode('ascii')),
        'packedGzip9Bytes': len(gzip.compress(packed.encode('ascii'), compresslevel=9, mtime=0)),
        'generatedBytes': len(text),
        'generatedGzip9Bytes': len(gzip.compress(text, compresslevel=9, mtime=0)),
        'generatedSha256': digest(text),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Check without changing generated data')
    args = parser.parse_args()
    output, report = build()
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_bytes() != output:
            raise SystemExit('unicodeEscapeNamesData.ts is stale; regenerate with this script')
    else:
        OUTPUT.write_bytes(output)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
