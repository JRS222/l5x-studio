#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""L5X Studio - build the component parts catalog JS data file.

Reads the maintenance master parts list workbook and emits a classic (non-module)
JavaScript data file used by the Conveyor Design Studio parts/BOM engine:

    js/data/parts-catalog.js   ->  L5XStudio.PARTS_CATALOG (browser) / module.exports (Node)

Input workbook: a site master parts list (.xlsx)
  sheet "site master parts list" (data rows)
      NSN, P/N, OEM, CAGE, DESCRIPTION, TYPE, UNIT COST TOPEKA, UNIT COST ONLINE,
      AVAILABLE BOH, CRITICALITY, DPSK, SSPK, SAMPLE_ST PART, LCUS PART, ...
  sheet "site group code"    (86 data rows)
      PSN, Description, PSIN, Available BOH, Comm Code, Replacement PSN, Repair Code,
      Hazard Code, Status Code, Group Code, Unit Price, Source Of Supply, ...

Output shape (consumed by js/conveyor/parts.js):

    PARTS_CATALOG = {
      generatedAt: "<workbook modified timestamp, ISO-8601>",
      source: { file, sheets, partsRows, siteRows, workflow, warning? },
      parts: [{ pn, nsn, oem, cage, description, type,
                unitCostLocal, unitCostOnline, availableBoh }],
      siteParts:  [{ psn, description, boh, commCode, replacementPsn,
                unitPrice, groupCode, statusCode, uom }]
    }

Determinism: the output only depends on the workbook contents (record order is the
sheet row order; generatedAt comes from the workbook's own "modified" property, not
the clock), so re-running over the same file produces byte-identical JS.

Usage:
    python tools/build-parts-catalog.py [xlsxPath] [outPath]

If the workbook is unavailable (Q: drive not mapped on this machine) the script
writes a small *synthetic* catalog instead of failing, flagged with
`source.warning`, so the app and tests still run. Exit code stays 0 in that case;
a hard error (unreadable file / openpyxl missing) exits 1.

Requires only the bundled Python + openpyxl (no network, no other dependencies).
"""

import datetime
import json
import os
import sys

DEFAULT_XLSX = r"Q:\Research Projects\My Stuff\Maintainability\NON-ILSP MASTER PARTS LIST.xlsx"
SHEET_PARTS = "site master parts list"
SHEET_SAMPLE_ST = "site group code"

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.normpath(os.path.join(HERE, "..", "js", "data", "parts-catalog.js"))


# --------------------------------------------------------------------------- helpers

def clean(value):
    """Normalize a cell to a trimmed single-line string ('' for blank cells)."""
    if value is None:
        return ""
    if isinstance(value, float):
        # openpyxl returns 123.0 for integer-looking cells -> keep stable text form
        return str(int(value)) if value.is_integer() else repr(value)
    if isinstance(value, datetime.datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, datetime.date):
        return value.isoformat()
    text = str(value).replace("\r\n", "\n").replace("\r", "\n")
    return text.strip()


def clean_text(value):
    """Like clean() but flattens embedded newlines (descriptions stay one-liners)."""
    return " ".join(clean(value).split())


def to_number(value, ndigits=4):
    """Parse a cost/price cell to a float or None. Tolerates '$', ',', 'USD' noise."""
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        text = clean(value).replace("$", "").replace(",", "").replace(" ", "")
        if not text:
            return None
        try:
            number = float(text)
        except ValueError:
            return None
    if number != number:  # NaN
        return None
    return round(number, ndigits)


def to_int(value):
    number = to_number(value)
    return None if number is None else int(number)


def cell(row, index):
    return row[index] if index < len(row) else None


# --------------------------------------------------------------------------- builders

def build_parts(rows):
    """Rows of sheet 1 -> catalog.parts records (rows without any identity are dropped)."""
    parts = []
    for row in rows:
        pn = clean(cell(row, 1))
        nsn = clean(cell(row, 0))
        description = clean_text(cell(row, 4))
        if not pn and not nsn and not description:
            continue
        parts.append({
            "pn": pn,
            "nsn": nsn,
            "oem": clean_text(cell(row, 2)),
            "cage": clean_text(cell(row, 3)),
            "description": description,
            "type": clean_text(cell(row, 5)),
            "unitCostLocal": to_number(cell(row, 6)),
            "unitCostOnline": to_number(cell(row, 7)),
            "availableBoh": to_int(cell(row, 8)),
        })
    return parts


def build_siteParts(rows):
    """Rows of sheet 2 -> catalog.siteParts records."""
    siteParts = []
    for row in rows:
        psn = clean(cell(row, 0))
        description = clean_text(cell(row, 1))
        if not psn and not description:
            continue
        siteParts.append({
            "psn": psn,
            "description": description,
            "boh": to_int(cell(row, 3)),
            "commCode": clean(cell(row, 4)),
            "replacementPsn": clean(cell(row, 5)),
            "unitPrice": to_number(cell(row, 10)),
            "groupCode": clean(cell(row, 9)),
            "statusCode": clean(cell(row, 8)),
            "uom": clean(cell(row, 16)),
        })
    return siteParts


def synthetic_catalog(reason):
    """Small offline stand-in so the app/tests keep working without the Q: drive."""
    parts = [
        {"pn": "1799ER-IQ10XOQ10", "nsn": "", "oem": "ROCKWELL AUTOMATION", "cage": "01121",
         "description": "DUAL PORT ETHERNET EMBEDDED I/O BOARD", "type": "I/O",
         "unitCostLocal": 348.8448, "unitCostOnline": None, "availableBoh": None},
        {"pn": "1799-BRKD", "nsn": "", "oem": "ROCKWELL AUTOMATION", "cage": "01121",
         "description": "1799ER MOUNTING BRACKET", "type": "MECHANICAL",
         "unitCostLocal": None, "unitCostOnline": 26.0, "availableBoh": None},
        {"pn": "1799-AUXCON", "nsn": "", "oem": "ROCKWELL AUTOMATION", "cage": "01121",
         "description": "1799ER POWER CONNECTOR", "type": "ELECTRICAL",
         "unitCostLocal": None, "unitCostOnline": 10.0, "availableBoh": None},
        {"pn": "BANQS18VP6LPQ8", "nsn": "", "oem": "BANNER", "cage": "",
         "description": "PHOTO EYE: BANNER #QS18 VP6LPQ8, 24VDC, M12, PNP, 18mm MOUNT",
         "type": "P/E", "unitCostLocal": None, "unitCostOnline": None, "availableBoh": None},
        {"pn": "CB-016S7", "nsn": "", "oem": "ITOH DENKI", "cage": "",
         "description": "CONTROLLER, DRIVE, POWER ROLLER, 24VDC, 4A", "type": "ROLLER",
         "unitCostLocal": None, "unitCostOnline": None, "availableBoh": None},
        {"pn": "1606-XL480EP", "nsn": "", "oem": "ROCKWELL AUTOMATION", "cage": "01121",
         "description": "POWER SUPPLY; 24-28VDC; 480W; RAIL MT", "type": "PSU",
         "unitCostLocal": None, "unitCostOnline": None, "availableBoh": None},
    ]
    siteParts = [
        {"psn": "3915120004742", "description": "ROLLER ASSY, DRIVE", "boh": 116,
         "commCode": "R", "replacementPsn": "", "unitPrice": 309.3191,
         "groupCode": "060", "statusCode": "A", "uom": "EA"},
        {"psn": "3040040000164", "description": "ROLLER, MOTORIZED, W/O CARD, W/2 GROOVES",
         "boh": 5, "commCode": "R", "replacementPsn": "", "unitPrice": 295.18,
         "groupCode": "196", "statusCode": "A", "uom": "EA"},
        {"psn": "3915050000466", "description": "ROLLER ASSY, MOTORIZED, W/TAPERED SLEEVE",
         "boh": 71, "commCode": "R", "replacementPsn": "", "unitPrice": 281.1631,
         "groupCode": "060", "statusCode": "A", "uom": "EA"},
    ]
    now = datetime.datetime.now().replace(microsecond=0).isoformat(sep=" ")
    return {
        "generatedAt": now,
        "source": {
            "file": "SYNTHETIC (site master parts list not found)",
            "sheets": [],
            "partsRows": len(parts),
            "siteRows": len(siteParts),
            "workflow": "synthetic-fallback",
            "warning": reason,
        },
        "parts": parts,
        "siteParts": siteParts,
    }


# --------------------------------------------------------------------------- emission

def render_js(catalog):
    """Emit the classic-script data file (browser namespace + Node module.exports)."""
    body = json.dumps(catalog, ensure_ascii=False, separators=(",", ":"))
    lines = [
        "/* L5X Studio - js/data/parts-catalog.js (GENERATED FILE - DO NOT EDIT)",
        '   Built by tools/build-parts-catalog.py from the site master parts list.',
        "   Browser: classic script assigning L5XStudio.PARTS_CATALOG;",
        "   Node: module.exports = catalog object.",
        "   Regenerate: python tools/build-parts-catalog.py */",
        "(function (root) {",
        '  "use strict";',
        "  var CATALOG = " + body + ";",
        '  if (typeof module === "object" && module.exports) module.exports = CATALOG;',
        "  else { root.L5XStudio = root.L5XStudio || {}; root.L5XStudio.PARTS_CATALOG = CATALOG; }",
        "})(typeof self !== \"undefined\" ? self : this);",
        "",
    ]
    return "\n".join(lines)


def workbook_stamp(wb, path):
    """Stable timestamp: the workbook's own 'modified' property (fallback: mtime)."""
    try:
        props = wb.properties
        stamped = getattr(props, "modified", None) or getattr(props, "created", None)
        if isinstance(stamped, (datetime.datetime, datetime.date)):
            return stamped.isoformat(timespec="seconds") if isinstance(stamped, datetime.datetime) else stamped.isoformat()
    except Exception:
        pass
    mtime = os.path.getmtime(path)
    return datetime.datetime.fromtimestamp(mtime).replace(microsecond=0).isoformat(" ")


def build_catalog(xlsx_path):
    """Load the workbook and return the catalog dict."""
    if not xlsx_path or not os.path.isfile(xlsx_path):
        return synthetic_catalog(
            "Workbook not found: %s - synthetic catalog written (parts/BOM still functional)."
            % (xlsx_path or "(no path)"))
    try:
        import openpyxl  # bundled Python ships with openpyxl
    except Exception as exc:  # pragma: no cover - environment problem
        raise SystemExit("ERROR: openpyxl is required to build the catalog: %s" % exc)
    try:
        wb = openpyxl.load_workbook(xlsx_path, data_only=True, read_only=True)
    except Exception as exc:
        return synthetic_catalog("Could not read workbook %s: %s" % (xlsx_path, exc))
    try:
        missing = [s for s in (SHEET_PARTS, SHEET_SAMPLE_ST) if s not in wb.sheetnames]
        if missing:
            return synthetic_catalog("Workbook is missing sheet(s): %s" % ", ".join(missing))
        rows_parts = list(wb[SHEET_PARTS].iter_rows(values_only=True))
        rows_siteParts = list(wb[SHEET_SAMPLE_ST].iter_rows(values_only=True))
        stamp = workbook_stamp(wb, xlsx_path)
    finally:
        wb.close()
    parts = build_parts(rows_parts[1:])
    siteParts = build_siteParts(rows_siteParts[1:])
    return {
        "generatedAt": stamp,
        "source": {
            "file": os.path.basename(xlsx_path),
            "sheets": [SHEET_PARTS, SHEET_SAMPLE_ST],
            "partsRows": len(parts),
            "siteRows": len(siteParts),
            "workflow": "master-parts-list",
        },
        "parts": parts,
        "siteParts": siteParts,
    }


def main(argv):
    xlsx_path = argv[1] if len(argv) > 1 else DEFAULT_XLSX
    out_path = argv[2] if len(argv) > 2 else DEFAULT_OUT
    catalog = build_catalog(xlsx_path)
    js = render_js(catalog)
    out_dir = os.path.dirname(os.path.abspath(out_path))
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir)
    with open(out_path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(js)
    src = catalog["source"]
    print("wrote %s" % os.path.relpath(out_path))
    print("  parts: %d  siteParts: %d  bytes: %d" % (len(catalog["parts"]), len(catalog["siteParts"]), len(js.encode("utf-8"))))
    print("  source: %s (%s)" % (src["file"], src.get("workflow")))
    if src.get("warning"):
        print("  WARNING: %s" % src["warning"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
