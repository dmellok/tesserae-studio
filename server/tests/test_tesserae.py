from __future__ import annotations

import httpx
import pytest

from studio_server.tesserae import PushError, TesseraeClient


@pytest.mark.asyncio
async def test_widget_choices_collects_every_page() -> None:
    offsets: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/mcp/widgets/history/choices"
        assert request.headers["Authorization"] == "Bearer secret"
        assert request.url.params["option"] == "entities"
        assert request.url.params["limit"] == "1000"
        offset = int(request.url.params["offset"])
        offsets.append(offset)
        rows = (
            [{"value": f"sensor.{index}", "label": f"Sensor {index}"} for index in range(1000)]
            if offset == 0
            else [{"value": "sensor.1000", "label": "Sensor 1000"}]
        )
        return httpx.Response(
            200,
            json={
                "key": "history",
                "option": "entities",
                "total": 1001,
                "offset": offset,
                "choices": rows,
            },
        )

    client = TesseraeClient("http://tess.test", mcp_token="secret")
    client.raw._transport = httpx.MockTransport(handler)
    try:
        result = await client.widget_choices("history", "entities")
    finally:
        await client.aclose()

    assert offsets == [0, 1000]
    assert result[0] == {"value": "sensor.0", "label": "Sensor 0"}
    assert result[-1] == {"value": "sensor.1000", "label": "Sensor 1000"}
    assert len(result) == 1001


@pytest.mark.asyncio
async def test_widget_choices_rejects_a_page_that_makes_no_progress() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        assert calls <= 2, "the client requested again after an empty page"
        rows = [{"value": "one", "label": "One"}] if calls == 1 else []
        return httpx.Response(
            200,
            json={
                "key": "demo",
                "option": "items",
                "total": 2,
                "offset": calls - 1,
                "choices": rows,
            },
        )

    client = TesseraeClient("http://tess.test")
    client.raw._transport = httpx.MockTransport(handler)
    try:
        with pytest.raises(PushError, match="incomplete choices response") as exc:
            await client.widget_choices("demo", "items")
    finally:
        await client.aclose()

    assert exc.value.status == 502


@pytest.mark.asyncio
async def test_widget_choices_rejects_a_page_without_a_total() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "key": "demo",
                "option": "items",
                "offset": 0,
                "choices": [{"value": "one", "label": "One"}],
            },
        )

    client = TesseraeClient("http://tess.test")
    client.raw._transport = httpx.MockTransport(handler)
    try:
        with pytest.raises(PushError, match="without a total") as exc:
            await client.widget_choices("demo", "items")
    finally:
        await client.aclose()

    assert exc.value.status == 502
