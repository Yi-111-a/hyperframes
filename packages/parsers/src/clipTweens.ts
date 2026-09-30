// Tweens a timeline move or retime of a clip carries: its own selector, plus (given a DOM) any whose every
// target sits inside the clip with no nearer `data-start` clip. A tween also aiming outside stays put.
export function clipTweenMatcher(
  clipSelector: string,
  root?: ParentNode,
): (tweenSelector: string) => boolean {
  const clips = root ? queryAll(root, clipSelector) : [];
  return (tweenSelector) => {
    if (tweenSelector === clipSelector) return true;
    if (!root || clips.length === 0) return false;
    const targets = queryAll(root, tweenSelector);
    return (
      targets.length > 0 &&
      targets.every((target) => {
        const owner = target.closest("[data-start]");
        return owner !== null && clips.includes(owner);
      })
    );
  };
}

function queryAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    // Pseudo-selectors such as a proxy or dwell label never match the DOM.
    return [];
  }
}
