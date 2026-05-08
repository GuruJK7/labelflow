#!/usr/bin/env python3
"""
Free-tier geocoder for Uruguay addresses. Uses OpenStreetMap's Nominatim
public API (no API key required, ~1 req/s rate limit). Used by Claude (via
Bash) when an address lacks a number ("Cisnes", "San Francisco s/n") or has
a cross-street reference ("entre X y Y").

Usage:
    python3 geocode.py "<address string>"
    python3 geocode.py "Cisnes, Montevideo, Uruguay"

Output (JSON to stdout):
    {"matches": [{"display_name": "...", "lat": "...", "lon": "...",
                  "address": {"road": "...", "house_number": "..."},
                  "type": "...", "importance": 0.45}, ...]}
    {"matches": [], "reason": "..."}

Etiquette:
- Sets a User-Agent identifying LabelFlow per Nominatim's usage policy.
- Limits to 5 results.
- Short timeout (8 s) so Claude doesn't hang the bridge.
"""
import json
import sys
import urllib.parse
import urllib.request


NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "LabelFlow-Bridge/1.0 (https://autoenvia.com)"
TIMEOUT_SECONDS = 8


def geocode(query: str) -> dict:
    if not query or not query.strip():
        return {"matches": [], "reason": "empty query"}

    params = {
        "q": query,
        "format": "json",
        "addressdetails": "1",
        "limit": "5",
        "countrycodes": "uy",   # Uruguay only — boosts precision
        "accept-language": "es",
    }
    url = NOMINATIM_URL + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})

    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {"matches": [], "reason": f"nominatim error: {type(e).__name__}: {e}"}

    if not isinstance(data, list):
        return {"matches": [], "reason": "unexpected response shape"}

    matches = []
    for item in data[:5]:
        addr = item.get("address", {}) or {}
        matches.append({
            "display_name": item.get("display_name"),
            "lat": item.get("lat"),
            "lon": item.get("lon"),
            "type": item.get("type"),
            "importance": item.get("importance"),
            "address": {
                "road": addr.get("road"),
                "house_number": addr.get("house_number"),
                "neighbourhood": addr.get("neighbourhood") or addr.get("suburb"),
                "city": addr.get("city") or addr.get("town") or addr.get("village"),
                "state": addr.get("state"),
                "postcode": addr.get("postcode"),
                "country": addr.get("country"),
            },
        })

    if not matches:
        return {"matches": [], "reason": "no results"}
    return {"matches": matches}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: geocode.py \"<address>\""}), file=sys.stderr)
        sys.exit(2)
    print(json.dumps(geocode(sys.argv[1]), ensure_ascii=False))
