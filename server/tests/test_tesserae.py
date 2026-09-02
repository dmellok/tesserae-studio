from __future__ import annotations

import httpx
import pytest

from studio_server.tesserae import PushError, TesseraeClient


@pytest.mark.asyncio
async def test_widget_choices_returns_one_bounded_search_page() -> None:
    offsets: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/mcp/widgets/history/choices"
        assert request.headers["Authorization"] == "Bearer secret"
        assert request.url.params["option"] == "entities"
        assert request.url.params["q"] == "kitchen"
        assert request.url.params["limit"] == "100"
        offset = int(request.url.params["offset"])
        offsets.append(offset)
        return httpx.Response(
            200,
            json={
                "key": "history",
                "option": "entities",
                "total": 1001,
                "offset": offset,
                "choices": [{"value": "sensor.kitchen", "label": "Kitchen"}],
            },
        )

    client = TesseraeClient("http://tess.test", mcp_token="secret")
    client.raw._transport = httpx.MockTransport(handler)
    try:
        choices, total = await client.widget_choices("history", "entities", q="kitchen", offset=200)
    finally:
        await client.aclose()

    assert offsets == [200]
    assert choices == [{"value": "sensor.kitchen", "label": "Kitchen"}]
    assert total == 1001


@pytest.mark.asyncio
async def test_widget_choices_rejects_a_page_that_makes_no_progress() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            json={
                "key": "demo",
                "option": "items",
                "total": 2,
                "offset": 1,
                "choices": [],
            },
        )

    client = TesseraeClient("http://tess.test")
    client.raw._transport = httpx.MockTransport(handler)
    try:
        with pytest.raises(PushError, match="incomplete choices response") as exc:
            await client.widget_choices("demo", "items", offset=1)
    finally:
        await client.aclose()

    assert exc.value.status == 502
    assert calls == 1


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
