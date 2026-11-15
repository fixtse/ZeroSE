#!/usr/bin/env python3
"""Export MyFitnessPal recipes, saved meals and logged foods for Zero's calorie tracker.

Run it whenever you add foods in MyFitnessPal. Each run merges into the existing export file:
recipes and meals are refreshed, and the diary is scanned from where the previous run stopped
(with a few days of overlap), so new foods are added without losing earlier ones. Zero imports
the file automatically the next time a food tool is used.

Setup (once):
    python3 -m venv ~/.venvs/mfp && ~/.venvs/mfp/bin/pip install -r scripts/mfp-requirements.txt
    Log in at https://www.myfitnesspal.com in Firefox or Chrome on this machine.

Usage:
    ~/.venvs/mfp/bin/python scripts/mfp_export.py                  # incremental
    ~/.venvs/mfp/bin/python scripts/mfp_export.py --since 2020-01-01  # full diary history
    ~/.venvs/mfp/bin/python scripts/mfp_export.py --output data/nutrition/mfp-export.json

MyFitnessPal has no official API for this; python-myfitnesspal scrapes the website and can
break when the site changes. Diary-derived foods only contain the nutrient columns enabled in
your MyFitnessPal diary settings.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import tempfile
import time
import unicodedata
from pathlib import Path
from typing import Any

NUTRIENTS = ("calories", "protein", "carbohydrates", "fat", "fiber", "sugar", "sodium")
# python-myfitnesspal diary keys -> export keys
DIARY_KEYS = {key: key for key in NUTRIENTS} | {"carbs": "carbohydrates"}
# schema.org NutritionInformation keys used by get_recipe/get_meal -> export keys
RECIPE_KEYS = {
    "calories": "calories",
    "proteinContent": "protein",
    "carbohydrateContent": "carbohydrates",
    "fatContent": "fat",
    "fiberContent": "fiber",
    "sugarContent": "sugar",
    "sodiumContent": "sodium",
}
OVERLAP_DAYS = 3
DEFAULT_OUTPUT = Path(os.environ.get("ASSISTANT_DATA_DIR", "data")) / "nutrition" / "mfp-export.json"


def number(value: Any) -> float | None:
    """Parse '1,234 calories', '12 g', 12 or a measurement object into a float."""
    if value is None:
        return None
    if hasattr(value, "value"):  # unit-aware measurement objects
        value = value.value
    if isinstance(value, (int, float)):
        return float(value)
    match = re.search(r"-?\d[\d,]*(?:\.\d+)?", str(value))
    if not match:
        return None
    text = match.group(0)
    if re.fullmatch(r"-?\d+,\d{1,2}", text):  # localized decimal comma: "1,5"
        return float(text.replace(",", "."))
    return float(text.replace(",", ""))


def slug(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def nutrients_from(mapping: dict[str, Any], keys: dict[str, str], divisor: float = 1) -> dict:
    result: dict[str, float | None] = {key: None for key in NUTRIENTS}
    for source, target in keys.items():
        value = number(mapping.get(source))
        if value is not None:
            result[target] = round(value / divisor, 2)
    return result


def recipe_food(kind: str, external_id: str, recipe: dict[str, Any]) -> dict[str, Any]:
    # MyFitnessPal shows recipe nutrition per serving; meals are a single serving.
    servings = number(recipe.get("recipeYield")) or 1
    return {
        "external_id": f"{kind}:{external_id}",
        "kind": kind,
        "name": str(recipe.get("name") or "").strip(),
        "brand": "",
        "serving_amount": 1,
        "serving_unit": "serving",
        "ingredients": [str(item).strip() for item in recipe.get("recipeIngredient") or [] if item],
        "recipe_servings": servings,
        **nutrients_from(recipe.get("nutrition") or {}, RECIPE_KEYS),
    }


def diary_food(entry: Any) -> dict[str, Any] | None:
    """A logged diary line becomes a food whose serving is the logged quantity and unit."""
    name = (entry.short_name or entry.name or "").strip()
    if not name:
        return None
    amount = number(entry.quantity) or 1
    unit = (entry.unit or "serving").strip()
    brand = ""
    if " - " in name:  # MyFitnessPal formats branded items as "Brand - Food"
        brand, name = (part.strip() for part in name.split(" - ", 1))
    return {
        "external_id": "diary:" + slug(f"{brand} {name} {unit}"),
        "kind": "food",
        "name": name,
        "brand": brand,
        "serving_amount": amount,
        "serving_unit": unit,
        "ingredients": [],
        **nutrients_from(dict(entry.nutrition_information), DIARY_KEYS),
    }


def load(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 1, "source": "myfitnesspal", "foods": []}
    data = json.loads(path.read_text("utf-8"))
    if data.get("version") != 1:
        sys.exit(f"{path} has an unsupported export version")
    return data


def save(path: Path, data: dict[str, Any]) -> None:
    """Atomic write so Zero never imports a half-written file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    data["foods"].sort(key=lambda food: (food["kind"], food["name"].lower()))
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False, encoding="utf-8") as tmp:
        json.dump(data, tmp, ensure_ascii=False, indent=2)
        tmp.write("\n")
    os.replace(tmp.name, path)


def retry(label: str, call, attempts: int = 3):
    for attempt in range(1, attempts + 1):
        try:
            return call()
        except Exception as error:  # the scraper raises many unrelated exception types
            if attempt == attempts:
                print(f"  ! skipped {label}: {error}", file=sys.stderr)
                return None
            time.sleep(2 * attempt)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--since", type=dt.date.fromisoformat, help="scan the diary from this date (YYYY-MM-DD)")
    parser.add_argument("--days", type=int, default=90, help="diary days to scan on the first run (default 90)")
    parser.add_argument("--no-diary", action="store_true", help="only export recipes and saved meals")
    parser.add_argument("--delay", type=float, default=0.5, help="seconds between diary requests")
    args = parser.parse_args()

    try:
        import myfitnesspal
    except ImportError:
        sys.exit("Install the exporter dependencies: pip install -r scripts/mfp-requirements.txt")

    data = load(args.output)
    foods: dict[str, dict[str, Any]] = {food["external_id"]: food for food in data["foods"]}
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    before = set(foods)

    def upsert(food: dict[str, Any] | None) -> None:
        if not food or not food["name"]:
            return
        previous = foods.get(food["external_id"], {})
        food["first_seen"] = previous.get("first_seen", now)
        food["last_seen"] = now
        foods[food["external_id"]] = food

    print("Connecting with your browser's MyFitnessPal session…")
    try:
        client = myfitnesspal.Client()
    except Exception as error:
        sys.exit(f"Could not authenticate. Log in at myfitnesspal.com in your browser first. ({error})")

    recipes = retry("recipe list", client.get_recipes) or {}
    print(f"Recipes: {len(recipes)}")
    for recipe_id, title in recipes.items():
        recipe = retry(f"recipe {title}", lambda: client.get_recipe(recipe_id))
        if recipe:
            upsert(recipe_food("recipe", str(recipe_id), recipe))

    meals = retry("meal list", client.get_meals) or {}
    print(f"Saved meals: {len(meals)}")
    for meal_id, title in meals.items():
        meal = retry(f"meal {title}", lambda: client.get_meal(meal_id, title))
        if meal:
            upsert(recipe_food("meal", str(meal_id), meal))

    if not args.no_diary:
        today = dt.date.today()
        scanned = data.get("diary_scanned_through")
        if args.since:
            start = args.since
        elif scanned:
            start = dt.date.fromisoformat(scanned) - dt.timedelta(days=OVERLAP_DAYS)
        else:
            start = today - dt.timedelta(days=args.days)
        print(f"Diary: {start} → {today}")
        day = start
        while day <= today:
            diary = retry(f"diary {day}", lambda: client.get_date(day))
            for meal in diary.meals if diary else []:
                for entry in meal.entries:
                    upsert(diary_food(entry))
            if diary is not None:
                data["diary_scanned_through"] = day.isoformat()
            day += dt.timedelta(days=1)
            time.sleep(args.delay)

    data["foods"] = list(foods.values())
    data["exported_at"] = now
    save(args.output, data)
    added = sorted(foods[key]["name"] for key in set(foods) - before)
    print(f"Saved {len(foods)} foods to {args.output} ({len(added)} new)")
    for name in added[:50]:
        print(f"  + {name}")


if __name__ == "__main__":
    main()
