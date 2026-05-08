#!/usr/bin/env python3
"""
DAC catalog validator — checks if a city/department combination is valid for
DAC. Used by Claude (via Bash) when correcting addresses.

Backed by the same canonical list LabelFlow's worker uses, embedded inline so
the helper has zero external file dependencies and works even if the offline
DAC catalog file moves.

Usage:
    python3 dac_catalog.py "<city>"
    python3 dac_catalog.py "<city>" "<department>"

Output (JSON to stdout):
    {"matches": [{"city": "...", "department": "...", "score": 1.0}, ...]}
    {"matches": []}  (when no candidate at all)
"""
import json
import sys
import unicodedata
from typing import Optional


# DAC's 19 departments. The address resolver MUST pick one of these as the
# `department` value — DAC's dropdown rejects anything else.
DAC_DEPARTMENTS = [
    "Artigas", "Canelones", "Cerro Largo", "Colonia", "Durazno",
    "Flores", "Florida", "Lavalleja", "Maldonado", "Montevideo",
    "Paysandú", "Río Negro", "Rivera", "Rocha", "Salto",
    "San José", "Soriano", "Tacuarembó", "Treinta y Tres",
]

# City → department map. Sourced from
# apps/worker/src/dac/dac-geo-map.json (the embedded list LabelFlow uses).
# Entries are normalized lowercase + ASCII for matching, but the canonical
# casing is preserved for the output.
CITY_TO_DEPARTMENT = {
    "montevideo": "Montevideo",
    "ciudad de la costa": "Canelones", "lagomar": "Canelones",
    "solymar": "Canelones", "el pinar": "Canelones", "shangrila": "Canelones",
    "las piedras": "Canelones", "pando": "Canelones", "canelones": "Canelones",
    "la paz": "Canelones", "atlántida": "Canelones", "atlantida": "Canelones",
    "salinas": "Canelones", "san josé de carrasco": "Canelones",
    "colonia nicolich": "Canelones", "paso carrasco": "Canelones",
    "punta del este": "Maldonado", "maldonado": "Maldonado",
    "san carlos": "Maldonado", "piriápolis": "Maldonado", "piriapolis": "Maldonado",
    "punta ballena": "Maldonado", "la barra": "Maldonado",
    "salto": "Salto", "paysandú": "Paysandú", "paysandu": "Paysandú",
    "rivera": "Rivera", "tacuarembó": "Tacuarembó", "tacuarembo": "Tacuarembó",
    "minas": "Lavalleja", "treinta y tres": "Treinta y Tres",
    "melo": "Cerro Largo", "artigas": "Artigas",
    "florida": "Florida", "durazno": "Durazno",
    "trinidad": "Flores", "san josé": "San José", "san jose": "San José",
    "ciudad del plata": "San José", "libertad": "San José",
    "fray bentos": "Río Negro", "young": "Río Negro",
    "mercedes": "Soriano", "dolores": "Soriano", "cardona": "Soriano",
    "colonia del sacramento": "Colonia", "colonia": "Colonia",
    "carmelo": "Colonia", "nueva palmira": "Colonia", "rosario": "Colonia",
    "rocha": "Rocha", "la paloma": "Rocha", "chuy": "Rocha",
    "punta del diablo": "Rocha", "castillos": "Rocha",
    "25 de mayo": "Florida",
}


def normalize(s: str) -> str:
    """Lowercase, strip diacritics, collapse whitespace."""
    if not s:
        return ""
    decomposed = unicodedata.normalize("NFD", s.lower().strip())
    stripped = "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
    return " ".join(stripped.split())


def lookup(city: str, dept_hint: Optional[str] = None) -> dict:
    norm_city = normalize(city)
    if not norm_city:
        return {"matches": [], "reason": "empty city"}

    # Exact match
    if norm_city in CITY_TO_DEPARTMENT:
        return {"matches": [{"city": city, "department": CITY_TO_DEPARTMENT[norm_city], "score": 1.0}]}

    # Department hint match — caller asserted a dept; validate it
    if dept_hint:
        norm_dept_hint = normalize(dept_hint)
        for dept in DAC_DEPARTMENTS:
            if normalize(dept) == norm_dept_hint:
                # The hint is a valid DAC dept name; trust it
                return {"matches": [{"city": city, "department": dept, "score": 0.7, "via": "dept_hint"}]}

    # Substring search — the user might have typed "monte" or "ciudad costa"
    candidates = []
    for known_city, dept in CITY_TO_DEPARTMENT.items():
        if norm_city in known_city or known_city in norm_city:
            score = min(len(norm_city), len(known_city)) / max(len(norm_city), len(known_city))
            candidates.append({"city": known_city, "department": dept, "score": round(score, 2)})
    candidates.sort(key=lambda x: -x["score"])

    if candidates:
        return {"matches": candidates[:5]}

    return {"matches": [], "reason": f"city '{city}' not in DAC catalog"}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: dac_catalog.py <city> [<department>]"}), file=sys.stderr)
        sys.exit(2)
    city_arg = sys.argv[1]
    dept_arg = sys.argv[2] if len(sys.argv) > 2 else None
    result = lookup(city_arg, dept_arg)
    print(json.dumps(result, ensure_ascii=False))
