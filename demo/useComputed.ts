import { useRef } from "react";
import { useSyncExternalStore } from "react";
import { Signal } from "@lit-labs/signals";

export function useSignal<T>(
  signal: Signal.State<T> | Signal.Computed<T>,
): T {
  return useSyncExternalStore(
    (callback) => {
      const w = new Signal.subtle.Watcher(() => {
        queueMicrotask(() => {
          w.watch();
          callback();
        });
      });
      w.watch(signal);
      return () => w.unwatch(signal);
    },
    () => signal.get(),
    () => signal.get(),
  );
}

export function useComputed<T>(compute: () => T): T {
  const computedRef = useRef<Signal.Computed<T> | undefined>(undefined);
  if (!computedRef.current) {
    computedRef.current = new Signal.Computed(compute);
  }
  return useSignal(computedRef.current);
}
