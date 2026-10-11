#!/usr/bin/env python3
"""Drive the real atlas template/controller in Chromium; no live Foundry claim."""

from __future__ import annotations

import argparse
import functools
import json
import math
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
LOCAL_VENDOR = ROOT / "node_modules" / "handlebars" / "dist" / "handlebars.min.js"
DEFAULT_VENDOR = (LOCAL_VENDOR if LOCAL_VENDOR.is_file()
                  else Path("/workspace/cpr-dev-environment/node_modules/handlebars/dist/handlebars.min.js"))


class QuietHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, vendor, **kwargs):
        self.vendor = vendor
        super().__init__(*args, **kwargs)

    def do_GET(self):
        if urlsplit(self.path).path == "/__vendor/handlebars.min.js":
            body = self.vendor.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, _format, *_args):
        pass


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def state(page):
    return page.evaluate("harness.controller.getState()")


def roles(page, role):
    return page.locator(f'[data-role="{role}"]')


def rows(page):
    return roles(page, "locations").locator('[data-action="select"]')


def find_code(data, code):
    return next(place for place in data["locations"]
                if any(marker["code"] == code for marker in place["mapMarkers"]))


def selected(page, identifier):
    page.wait_for_function("id => harness.controller.getState().selectedId === id", arg=identifier)


def search(page, text):
    roles(page, "search").fill(text)


def select_row(page, identifier):
    roles(page, "locations").locator(f'[data-action="select"][data-location-id="{identifier}"]').click()
    selected(page, identifier)


def point_on_image(page, x, y):
    return page.evaluate("""([x, y]) => {
      const view = harness.controller.getState().view;
      const viewport = harness.root.querySelector('[data-role="viewport"]').getBoundingClientRect();
      return { x: viewport.left + view.x + x * harness.dataset.map.width * view.scale,
               y: viewport.top + view.y + y * harness.dataset.map.height * view.scale };
    }""", [x, y])


def run_behaviors(page, data, screenshot):
    page.wait_for_function("window.harnessReady === true")
    page.wait_for_function("harness.root.querySelector('[data-role=map-image]').naturalWidth === 1200")
    check(rows(page).count() == 549, "Initial catalogue must show 549 sourced places")
    check(roles(page, "markers").locator("button").count() == 156, "Initial map must show 156 official points")
    check(roles(page, "map-error").is_hidden(), "Map image failed to decode")
    afterlife, university = find_code(data, "B1"), find_code(data, "F4")

    search(page, "Посмертие")
    check(rows(page).count() == 1, "Russian place search should identify Посмертие")
    select_row(page, afterlife["id"])
    check(roles(page, "detail").locator("h2").inner_text() == "Посмертие", "Selected point opened the wrong place")
    check(roles(page, "detail").locator(".nc-atlas__description").inner_text() == afterlife["description"],
          "The UI truncated or changed the wiki description")
    check("Карта: B1" in roles(page, "detail").inner_text(), "Selected card must show official map code B1")
    check("Первая карта: 75" in roles(page, "detail").inner_text(), "Cross-map alias 75 must remain distinct")
    link = roles(page, "detail").locator("a")
    check(link.get_attribute("href") == afterlife["sourceUrl"], "Wiki source citation changed")
    check(link.get_attribute("rel") == "noopener noreferrer", "External source link lacks isolation")

    for term in ("afterlife", "75"):
        search(page, term)
        check(roles(page, "locations").locator(f'[data-location-id="{afterlife["id"]}"][data-action="select"]').count() == 1,
              f"Verified alias search {term} did not find B1")
    search(page, "F4")
    check(rows(page).count() == 1, "Official F4 code search should produce one result")
    select_row(page, university["id"])
    check("University" in roles(page, "detail").locator("h2").inner_text(), "F4 did not select Night City University")
    check(university["wikiSectionRef"] == "F11", "Test reference unexpectedly confuses F4 and wiki F11")

    search(page, "")
    roles(page, "district").select_option(label="Верхняя Гавань")
    expected_district_count = sum(place["district"] == "Верхняя Гавань" for place in data["locations"])
    check(rows(page).count() == expected_district_count == 40, "District filter crossed district boundaries")
    roles(page, "district").select_option("")
    roles(page, "placed-only").check()
    check(rows(page).count() == 156, "Placed-only filter must exclude 393 unplaced wiki records")
    roles(page, "placed-only").uncheck()
    print("PASS: catalogue/markers; Russian and cross-map alias search; F4 vs wiki F11; full descriptions; district/placed filters")

    page.locator('[data-action="fit"]').click()
    fitted = state(page)["view"]
    page.locator('[data-action="zoom-in"]').click()
    check(state(page)["view"]["scale"] > fitted["scale"], "Zoom button did not increase the map scale")
    page.locator('[data-action="fit"]').click()
    check(math.isclose(state(page)["view"]["scale"], fitted["scale"], rel_tol=1e-6), "Fit failed to restore the full city view")
    search(page, "Посмертие")
    select_row(page, afterlife["id"])
    view_before = state(page)["view"]
    viewport = roles(page, "viewport").bounding_box()
    page.mouse.move(viewport["x"] + 55, viewport["y"] + 120)
    page.mouse.down()
    page.mouse.move(viewport["x"] + 88, viewport["y"] + 145, steps=5)
    page.mouse.up()
    view_after = state(page)["view"]
    check(abs(view_after["x"] - view_before["x"]) > 10 or abs(view_after["y"] - view_before["y"]) > 10,
          "Pointer drag did not pan the map")
    old_scale = view_after["scale"]
    page.mouse.move(viewport["x"] + viewport["width"] / 2, viewport["y"] + viewport["height"] / 2)
    page.mouse.wheel(0, -120)
    page.wait_for_function("scale => harness.controller.getState().view.scale > scale", arg=old_scale)
    roles(page, "viewport").focus()
    page.keyboard.press("f")
    check(math.isclose(state(page)["view"]["scale"], fitted["scale"], rel_tol=1e-6), "Keyboard fit did not work")
    print("PASS: selection; fit; button/wheel zoom; pointer pan; keyboard fit")

    favorite = roles(page, "detail").locator('[data-action="favorite"]')
    favorite.click()
    page.wait_for_function("id => harness.saved.favorites.includes(id)", arg=afterlife["id"])
    page.evaluate("harness.mount()")
    search(page, "Посмертие")
    select_row(page, afterlife["id"])
    favorite = roles(page, "detail").locator('[data-action="favorite"]')
    check(favorite.get_attribute("aria-pressed") == "true", "Favorite did not survive reopening")
    page.evaluate("harness.failures.favorites = true")
    favorite.click()
    page.wait_for_function("harness.notifications.some(text => text.includes('избранное'))")
    check(favorite.get_attribute("aria-pressed") == "true" and afterlife["id"] in state(page)["favorites"],
          "Failed favorite write must not pretend to have succeeded")
    roles(page, "favorites-only").check()
    check(rows(page).count() == 1, "Favorites-only filter did not preserve the saved place")
    page.evaluate("harness.failures.favorites = false")
    roles(page, "favorites-only").uncheck()
    print("PASS: favorites persist across reopening; failed setting writes preserve prior UI/data; favorite filter")

    unplaced = next(place for place in data["locations"] if not place["mapMarkers"])
    search(page, unplaced["name"])
    select_row(page, unplaced["id"])
    page.locator('[data-action="fit"]').click()
    roles(page, "detail").locator('[data-action="place"]').click()
    check(roles(page, "placement-banner").is_visible(), "Manual placement did not enter visible placement mode")
    official_snapshot = page.evaluate("JSON.stringify(harness.dataset.locations.flatMap(place => place.mapMarkers))")
    page.evaluate("harness.failures.customPins = true")
    point = point_on_image(page, 0.4, 0.4)
    page.mouse.click(point["x"], point["y"])
    page.wait_for_function("harness.notifications.some(text => text.includes('сохранить метку'))")
    check(unplaced["id"] not in state(page)["customPins"], "Failed custom pin write fabricated a saved pin")
    page.evaluate("harness.failures.customPins = false")
    page.mouse.click(point["x"], point["y"])
    page.wait_for_function("id => Boolean(harness.saved.customPins[id])", arg=unplaced["id"])
    pin = state(page)["customPins"][unplaced["id"]]
    check(math.isclose(pin["x"], 0.4, abs_tol=0.003) and math.isclose(pin["y"], 0.4, abs_tol=0.003),
          "Pointer placement used screen pixels instead of normalized map coordinates")
    check(roles(page, "markers").locator(".is-manual").count() == 1, "Manual point lacks its distinct marker style")
    page.evaluate("harness.mount()")
    search(page, unplaced["name"])
    select_row(page, unplaced["id"])
    check(roles(page, "detail").locator('[data-action="clear-pin"]').count() == 1, "Manual pin did not survive reopening")
    page.evaluate("harness.failures.customPins = true")
    roles(page, "detail").locator('[data-action="clear-pin"]').click()
    page.wait_for_function("harness.notifications.some(text => text.includes('удалить метку'))")
    check(unplaced["id"] in state(page)["customPins"], "Failed delete incorrectly hid the saved pin")
    page.evaluate("harness.failures.customPins = false")
    roles(page, "detail").locator('[data-action="clear-pin"]').click()
    page.wait_for_function("id => !harness.saved.customPins[id]", arg=unplaced["id"])
    writes = page.evaluate("harness.writes.customPins")
    page.evaluate("harness.controller.placeSelected(-0.2, 1.3)")
    check(page.evaluate("harness.writes.customPins") == writes, "Out-of-bounds pin reached the settings writer")
    page.evaluate("id => harness.controller.selectLocation(id)", afterlife["id"])
    check(roles(page, "detail").locator('[data-action="place"]').count() == 0, "Official location exposed manual placement control")
    page.evaluate("harness.controller.placeSelected(0.1, 0.1)")
    check(page.evaluate("harness.writes.customPins") == writes, "Official point was overwritten by a manual pin")
    check(page.evaluate("JSON.stringify(harness.dataset.locations.flatMap(place => place.mapMarkers))") == official_snapshot,
          "Manual placement mutated immutable official source coordinates")
    print("PASS: manual pin UI; normalized coordinates; reopen; write/delete failure; clear; bounds; official point immutability")

    previous_writes = page.evaluate("({...harness.writes})")
    page.evaluate("harness.gm = false")
    roles(page, "detail").locator('[data-action="favorite"]').click()
    page.evaluate("id => harness.controller.selectLocation(id)", unplaced["id"])
    roles(page, "detail").locator('[data-action="place"]').click()
    page.evaluate("harness.controller.placeSelected(0.3, 0.3)")
    check(page.evaluate("harness.writes") == previous_writes, "Non-GM reached the persistent settings writers")
    check(not state(page)["placement"], "Non-GM entered placement mode")
    page.evaluate("harness.gm = true")
    print("PASS: runtime GM checks reject favorites and manual placement mutations")

    page.evaluate("""() => {
      const dataset = structuredClone(harness.original);
      const unsafe = structuredClone(dataset.locations[0]);
      Object.assign(unsafe, { id: 'unsafe-fixture', name: 'malicious-marker-token <img src=x onerror="window.payloadRan=true">',
        description: '<script>window.payloadRan=true</script><img src=x onerror="window.payloadRan=true">',
        sourceUrl: 'javascript:window.payloadRan=true', aliases: [], originalMapReferences: [], mapMarkers: [] });
      dataset.locations.push(unsafe);
      window.payloadRan = false;
      harness.mount(dataset);
    }""")
    search(page, "malicious-marker-token")
    select_row(page, "unsafe-fixture")
    check(roles(page, "detail").locator("script, img").count() == 0, "Untrusted wiki text became executable DOM")
    check(roles(page, "detail").locator("a").count() == 0, "Unsafe source URL was rendered as a link")
    check("<script>" in roles(page, "detail").inner_text(), "Source text was not preserved as literal text")
    check(page.evaluate("window.payloadRan") is False, "Untrusted data executed JavaScript")

    page.evaluate("""() => {
      const oldRoot = harness.root;
      harness.controller.destroy();
      window.retiredRoot = oldRoot;
      harness.mount(structuredClone(harness.original));
    }""")
    before = page.evaluate("({...harness.writes})")
    page.evaluate("retiredRoot.querySelector('[data-action=favorite]').click()")
    check(page.evaluate("harness.writes") == before, "Destroyed controller retained its DOM listeners")
    search(page, "Посмертие")
    select_row(page, afterlife["id"])
    roles(page, "detail").locator('[data-action="favorite"]').click()
    page.wait_for_function("count => harness.writes.favorites === count + 1", arg=before["favorites"])
    check(page.evaluate("harness.writes.favorites") == before["favorites"] + 1, "Reopening duplicated action handlers")
    print("PASS: malicious content remains literal; unsafe links suppressed; destroy/reopen does not leak action listeners")

    page.set_viewport_size({"width": 640, "height": 700})
    page.wait_for_function("harness.root.getBoundingClientRect().width === 640")
    geometry = page.evaluate("""() => {
      const root = harness.root.getBoundingClientRect();
      const map = harness.root.querySelector('.nc-atlas__map-panel').getBoundingClientRect();
      const detail = harness.root.querySelector('[data-role=detail]').getBoundingClientRect();
      const viewport = harness.root.querySelector('[data-role=viewport]').getBoundingClientRect();
      return { rootWidth: root.width, documentWidth: document.documentElement.scrollWidth,
               mapBottom: map.bottom, detailTop: detail.top,
               viewportWidth: viewport.width, viewportHeight: viewport.height };
    }""")
    check(geometry["documentWidth"] <= 640, "Small-window layout overflows horizontally")
    check(geometry["detailTop"] >= geometry["mapBottom"] - 2, "Small-window layout did not move detail beneath the map")
    check(geometry["viewportWidth"] > 200 and geometry["viewportHeight"] > 150, "Small-window map became unusably small")
    check(roles(page, "search").is_visible() and roles(page, "detail").is_visible(), "Responsive layout lost search or selected card")
    if screenshot:
        page.screenshot(path=str(screenshot), full_page=True)
    page.evaluate("harness.controller.destroy()")
    print("PASS: 640px window keeps search/map/detail visible without horizontal overflow")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chromium", default=os.environ.get("CHROMIUM", "/usr/bin/chromium"))
    parser.add_argument("--handlebars", type=Path,
                        default=Path(os.environ.get("HANDLEBARS_BROWSER", str(DEFAULT_VENDOR))))
    parser.add_argument("--screenshot", type=Path, help="Optional local test screenshot")
    options = parser.parse_args()
    check(options.handlebars.is_file(), "Handlebars browser runtime unavailable; provide --handlebars")
    data = json.loads((ROOT / "data" / "locations.json").read_text(encoding="utf-8"))
    handler = functools.partial(QuietHandler, directory=str(ROOT), vendor=options.handlebars)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=options.chromium, headless=True,
                                                 args=["--disable-dev-shm-usage"])
            try:
                page = browser.new_page(viewport={"width": 1240, "height": 820})
                page.set_default_timeout(8000)
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                response = page.goto(f"http://127.0.0.1:{server.server_port}/tests/browser-harness.html")
                check(response is not None and response.ok, "Browser harness HTTP load failed")
                run_behaviors(page, data, options.screenshot)
                check(not errors, f"Browser JavaScript errors: {errors}")
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        check(not thread.is_alive(), "Temporary test HTTP server failed to stop")
    print("PASS: real template/controller/stylesheet; no browser JavaScript errors; browser/server closed")


if __name__ == "__main__":
    main()
