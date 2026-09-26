"""Read the user-supplied workbook without modifying it; retain provenance."""
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path
import openpyxl

source = Path(sys.argv[1])
out = Path(sys.argv[2])
workbook = openpyxl.load_workbook(source, read_only=True, data_only=True)
sheet = workbook['干员练度表']
rows = list(sheet.iter_rows(values_only=True))
assert list(rows[0][:5]) == ['干员名称', '是否已招募', '星级', '等级', '精英化等级'], rows[0][:5]
entries, provenance, missing = [], [], []
for index, row in enumerate(rows[1:], 2):
    if not row[0]:
        continue
    if row[1] is not True:
        missing.append({'row': index, 'operator': row[0], 'owned': row[1]})
        continue
    assert isinstance(row[3], int) and row[3] >= 1, (index, row[:5])
    assert isinstance(row[4], int) and row[4] in (0, 1, 2), (index, row[:5])
    entries.append({'operator': str(row[0]).strip(), 'elitePhase': row[4], 'level': row[3]})
    provenance.append({'row': index, **entries[-1]})
assert len({e['operator'] for e in entries}) == len(entries), 'duplicate operators'
summary = {'source': str(source), 'sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
           'sheet': sheet.title, 'dataRows': len(entries) + len(missing), 'owned': len(entries),
           'notOwned': len(missing), 'eliteCounts': dict(Counter(e['elitePhase'] for e in entries)),
           'rows': provenance, 'excluded': missing}
(out / 'inventory-raw.json').write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding='utf-8')
(out / 'inventory-source.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({k: v for k, v in summary.items() if k not in ('rows', 'excluded')}, ensure_ascii=True))
