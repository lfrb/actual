import { useSyncExternalStore } from 'react';

import { breakpoints } from '#tokens';

const serverSize = { width: 0, height: 0 };
const subscribers = new Set<() => void>();
let size: typeof serverSize | undefined;
let resizeTimeout: ReturnType<typeof setTimeout> | undefined;

function getSnapshot() {
  size ??= { width: window.innerWidth, height: window.innerHeight };
  return size;
}

function onResize() {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (size?.width === width && size.height === height) return;
    size = { width, height };
    subscribers.forEach(notify => notify());
  }, 250);
}

function subscribe(notify: () => void) {
  if (subscribers.size === 0) {
    window.addEventListener('resize', onResize);
    if (
      size?.width !== window.innerWidth ||
      size.height !== window.innerHeight
    ) {
      size = { width: window.innerWidth, height: window.innerHeight };
    }
  }
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0) {
      window.removeEventListener('resize', onResize);
      clearTimeout(resizeTimeout);
      size = undefined;
    }
  };
}

export function useResponsive() {
  const { height, width } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => serverSize,
  );

  // Possible view modes: narrow, small, medium, wide
  // To check if we're at least small width, check !isNarrowWidth
  return {
    // atLeastMediumWidth is provided to avoid checking (isMediumWidth || isWideWidth)
    atLeastMediumWidth: width >= breakpoints.medium,
    isNarrowWidth: width < breakpoints.small,
    isSmallWidth: width >= breakpoints.small && width < breakpoints.medium,
    isMediumWidth: width >= breakpoints.medium && width < breakpoints.wide,
    // No atLeastWideWidth because that's identical to isWideWidth
    isWideWidth: width >= breakpoints.wide,
    height,
    width,
  };
}
