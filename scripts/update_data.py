#!/usr/bin/env python3
"""Merge a fresh Salla snapshot into data.json (read by index.html).

Usage:
  python3 scripts/update_data.py --daily daily.csv --snapshot snapshot.json

daily.csv     rows "YYYY-MM-DD,orders,sales,customers" from the Salla report
              reports_orders_daily. Rows replace existing days with the same
              date; older days already in data.json are kept.
snapshot.json {
  "status_30d": {"completed":N,"processing":N,"canceled":N,"returned":N},
  "top": {"week"|"month"|"d30"|"year": [[name, qty, image_url], ...]},
  "recent": [[ref, first_name, last_name, city, "YYYY-MM-DD HH:MM",
              status_name, status_slug, total], ...]
}
Customer names are reduced to first name + last-name initial before saving,
because the published page is public.
"""
import argparse, csv, json, os, sys
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data.json")
RIYADH = timezone(timedelta(hours=3))

STATUS_GROUP = {
    "completed": "completed", "delivered": "completed", "delivering": "completed", "shipped": "completed",
    "under_review": "processing", "in_progress": "processing", "payment_pending": "processing",
    "canceled": "canceled", "deleted": "canceled",
    "restored": "returned", "restoring": "returned",
}


def mask(first, last):
    first = (first or "").strip().split(" ")[0] or "عميل"
    last = (last or "").strip().strip(".").strip()
    return f"{first} {last[0]}." if last else first


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--daily")
    ap.add_argument("--snapshot")
    a = ap.parse_args()

    data = {}
    if os.path.exists(DATA):
        with open(DATA, encoding="utf-8") as f:
            data = json.load(f)

    days = {d[0]: d for d in data.get("daily", [])}
    if a.daily:
        with open(a.daily, encoding="utf-8") as f:
            for row in csv.reader(f):
                if len(row) < 4 or not row[0][:4].isdigit():
                    continue
                d, o, s, c = row[0].strip(), int(float(row[1])), round(float(row[2]), 2), int(float(row[3]))
                days[d] = [d, o, s, c]
    data["daily"] = [days[k] for k in sorted(days)]

    if a.snapshot:
        with open(a.snapshot, encoding="utf-8") as f:
            snap = json.load(f)
        if "status_30d" in snap:
            data["status_30d"] = {k: int(snap["status_30d"].get(k, 0)) for k in ("completed", "processing", "canceled", "returned")}
        if "top" in snap:
            data["top"] = {k: [{"name": n, "qty": int(q), "img": img} for n, q, img in v[:5]] for k, v in snap["top"].items()}
        if "recent" in snap:
            data["recent"] = [{
                "ref": int(r[0]), "customer": mask(r[1], r[2]), "city": r[3] or "",
                "date": r[4], "status": r[5], "group": STATUS_GROUP.get(r[6], "processing"),
                "total": round(float(r[7]), 2),
            } for r in snap["recent"][:15]]

    if not data.get("daily"):
        sys.exit("no daily data — refusing to write an empty data.json")

    data["updated_at"] = datetime.now(RIYADH).strftime("%Y-%m-%dT%H:%M:%S+03:00")
    with open(DATA, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"data.json: {len(data['daily'])} days, last {data['daily'][-1][0]}, updated {data['updated_at']}")


if __name__ == "__main__":
    main()
