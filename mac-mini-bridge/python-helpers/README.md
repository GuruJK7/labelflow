# LabelFlow address-resolver Python helpers

Tiny standalone scripts the bridge's `claude -p` invocation can call via Bash
to enrich its address-resolution playbook. Pure stdlib — no `pip install`
required, no API keys, no external services beyond Nominatim (free, public).

## Install on Mac mini

These ship alongside `bridge-server.mjs`. The `install.sh` from `mac-mini-bridge/`
copies them to `~/labelflow-tools/` and chmod +x.

Manual install:

```sh
mkdir -p ~/labelflow-tools
cp python-helpers/*.py ~/labelflow-tools/
chmod +x ~/labelflow-tools/*.py
```

## Helpers

### `dac_catalog.py`
Validates a city name against DAC's known catalog. Returns the canonical
department name. Used to fix city/department mismatches without burning
WebSearch calls.

```sh
python3 ~/labelflow-tools/dac_catalog.py "Las Piedras"
# {"matches": [{"city": "Las Piedras", "department": "Canelones", "score": 1.0}]}
```

### `geocode.py`
Geocodes an address via OpenStreetMap Nominatim (free, ~1 req/s). Useful for
addresses that lack a street number or use cross-street references.

```sh
python3 ~/labelflow-tools/geocode.py "Cisnes, Montevideo, Uruguay"
# {"matches": [{"display_name": "...", "lat": "...", ...}, ...]}
```

## Why the bridge invokes these via Bash

Claude's CLI gets `--allowed-tools Bash,WebSearch,WebFetch,Read,Write`. The
prompt tells it to prefer the offline `dac_catalog.py` (instant, deterministic)
over WebSearch for the city→department mapping. For geocoding the prompt
prefers `geocode.py` (free Nominatim) over hitting Google Maps via WebFetch
(rate-limited, fragile). This keeps the average resolution under 30 seconds
and within the bridge's `CLAUDE_TIMEOUT_MS=180000` budget.
