const ENABLED =
  (process.env.LOCAL_GPU_SERIALIZE ?? "1") !== "0";

let tail: Promise<void> =
  Promise.resolve();

let active = 0;
let waiting = 0;
let completed = 0;
let lastLabel: string | null = null;

export async function runLocalGpuExclusive<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!ENABLED) {
    return operation();
  }

  waiting += 1;

  let release:
    (() => void) | undefined;

  const gate =
    new Promise<void>((resolve) => {
      release = resolve;
    });

  const previous = tail;

  tail =
    previous.then(
      () => gate,
      () => gate,
    );

  await previous;

  waiting -= 1;
  active += 1;
  lastLabel = label;

  try {
    return await operation();
  } finally {
    active -= 1;
    completed += 1;
    release?.();
  }
}

export function getLocalGpuQueueStatus() {
  return {
    enabled: ENABLED,
    active,
    waiting,
    completed,
    lastLabel,
  };
}
