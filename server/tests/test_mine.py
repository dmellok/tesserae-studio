"""mine_data_schema logic tests, over the real flattener output."""

from __future__ import annotations

from studio_server.flatten import flatten_fields
from studio_server.mine import humanize, infer_unit, leaf_key, mine

SAMPLE = {
    "temp": 19,
    "cond": "Cloudy",
    "humidity": 58,
    "wind_speed": 12.5,
    "hourly": [{"temp": 18}, {"temp": 19}],
    "updated": "2026-06-01T07:01",
    "tags": ["a", "b"],
}


def _mined():
    return mine(flatten_fields(SAMPLE), SAMPLE, None)


def test_leaf_key_and_humanize():
    assert leaf_key("current.temp") == "temp"
    assert leaf_key("hourly[].temp") == "temp"
    assert humanize("rain_chance") == "Rain chance"
    assert humanize("windSpeed") == "Wind speed"


def test_unit_inference():
    assert infer_unit("humidity", 58) == "%"
    assert infer_unit("wind_speed", 12.5) == "km/h"
    assert infer_unit("temp", 19) == "°"
    assert infer_unit("cond", "x") is None


def test_scalar_and_pluck_classification():
    by = {f["name"]: f for f in _mined()["fields"]}
    assert by["temp"]["type"] == "num" and by["temp"]["unit"] == "°"
    assert by["humidity"]["unit"] == "%"
    assert by["cond"]["type"] == "str" and by["cond"]["display"] == "text"
    # pluck path across an array of objects -> chartable array
    assert by["hourly[].temp"]["type"] == "arr"
    assert by["hourly[].temp"]["chartable"] is True
    # scalar array of strings -> non-chartable arr
    assert by["tags"]["type"] == "arr" and by["tags"]["chartable"] is False


def test_iso_datetime_format_hint():
    by = {f["name"]: f for f in _mined()["fields"]}
    assert by["updated"].get("format") == "HH:mm"


def test_object_array_not_bound_but_warns():
    res = _mined()
    names = {f["name"] for f in res["fields"]}
    assert "hourly" not in names  # the raw object[] is not a bindable field
    assert any("hourly[]" in w for w in res["warnings"])


def test_manifest_schema_shape_is_minimal():
    ds = _mined()["data_schema"]
    for f in ds["fields"]:
        assert set(f) <= {"name", "type", "label", "unit", "format"}
    assert "sample" in ds


def test_sample_is_truncated():
    big = {"blob": "x" * 200, "list": list(range(50))}
    ds = mine(flatten_fields(big), big, None)["data_schema"]
    assert ds["sample"]["blob"].endswith("…") and len(ds["sample"]["blob"]) <= 61
    assert len(ds["sample"]["list"]) == 3


def test_author_unit_not_overwritten():
    declared = {"fields": [{"name": "temp", "type": "num", "label": "Temperature", "unit": "F"}]}
    by = {f["name"]: f for f in mine(flatten_fields(SAMPLE), SAMPLE, declared)["fields"]}
    assert by["temp"]["unit"] == "F"  # kept the author's unit, not the inferred °
    assert by["temp"]["label"] == "Temperature"


def test_drift_report():
    declared = {
        "fields": [
            {"name": "temp", "type": "num", "unit": "°"},  # unchanged (unit matches)
            {"name": "gone", "type": "str"},  # removed
            {"name": "humidity", "type": "str"},  # changed (str -> num)
        ]
    }
    diff = mine(flatten_fields(SAMPLE), SAMPLE, declared)["diff"]
    assert "gone" in diff["removed"]
    assert "humidity" in diff["changed"]
    assert "wind_speed" in diff["added"]
    assert "temp" not in diff["changed"] and "temp" not in diff["added"]
