// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { makeSelection } from "../../hooks/domSelectionTestHarness";
import type { DomEditSelection } from "./domEditing";
import "./domEditOverlayTestMocks";
import { DomEditOverlay } from "./DomEditOverlay";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.setPointerCapture ??= () => {};
HTMLElement.prototype.releasePointerCapture ??= () => {};

const pointTarget = vi.hoisted(() => ({ current: null as HTMLElement | null }));
vi.mock("../../utils/studioPreviewHelpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/studioPreviewHelpers")>()),
  getPreviewTargetFromPointer: () => pointTarget.current,
}));
vi.mock("./useDomEditOverlayRects", () => ({
  useDomEditOverlayRects: () => ({
    overlayRect: null,
    overlayRectRef: { current: null },
    setOverlayRect: () => undefined,
    hoverRect: null,
    groupOverlayItems: [],
    groupOverlayItemsRef: { current: [] },
    setGroupOverlayItems: () => undefined,
    childRects: [],
  }),
}));

let root: Root;
const onCanvasMouseDown = vi.fn();

function render(hoverSelection: DomEditSelection | null) {
  act(() =>
    root.render(
      <DomEditOverlay
        iframeRef={{ current: document.createElement("iframe") }}
        activeCompositionPath={null}
        selection={null}
        hoverSelection={hoverSelection}
        onCanvasMouseDown={onCanvasMouseDown}
        onCanvasPointerMove={() => Promise.resolve(null)}
        onCanvasPointerLeave={() => undefined}
        onSelectionChange={() => undefined}
        onBlockedMove={() => undefined}
        onPathOffsetCommit={() => undefined}
        onGroupPathOffsetCommit={() => undefined}
        onBoxSizeCommit={() => undefined}
        onRotationCommit={() => undefined}
        onMarqueeSelect={() => undefined}
      />,
    ),
  );
}

// Like Chrome: a default-prevented pointerdown sends no compatibility mousedown.
function press(target: Element, shiftKey = false) {
  const init = { bubbles: true, cancelable: true, button: 0, pointerId: 1, shiftKey };
  const down = new PointerEvent("pointerdown", init);
  act(() => void target.dispatchEvent(down));
  if (!down.defaultPrevented)
    act(() => void target.dispatchEvent(new MouseEvent("mousedown", init)));
  act(() => void target.dispatchEvent(new PointerEvent("pointerup", init)));
}

afterEach(() => {
  act(() => root.unmount());
  onCanvasMouseDown.mockClear();
  pointTarget.current = null;
  document.body.innerHTML = "";
});

it.each([
  ["a press on empty canvas", false],
  ["a shift+click add", true],
])("after %s, the next click on an element selects it", (_, shiftFirst) => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const element = document.createElement("h1");
  document.body.append(element);
  const hover = makeSelection("Title", element);
  const overlay = () => host.firstElementChild!;

  pointTarget.current = shiftFirst ? element : null;
  render(shiftFirst ? hover : null);
  press(overlay(), shiftFirst);
  expect(onCanvasMouseDown).not.toHaveBeenCalled();

  pointTarget.current = element;
  render(hover);
  press(overlay());
  expect(onCanvasMouseDown).toHaveBeenCalledTimes(1);
});
