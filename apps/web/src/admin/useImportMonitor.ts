import { useEffect, useRef } from 'react';
import { getImportJob, getImportQuality } from '../api/client.ts';
import { createImportMonitor, type ImportSnapshot } from './import-monitor.ts';

export function useImportMonitor(onUpdate: (id: string, snapshot: ImportSnapshot) => void) {
  const listener = useRef(onUpdate);
  listener.current = onUpdate;
  const monitor = useRef<ReturnType<typeof createImportMonitor> | null>(null);
  if (!monitor.current) monitor.current = createImportMonitor(
    { job: getImportJob, quality: getImportQuality },
    (id, snapshot) => listener.current(id, snapshot),
  );
  useEffect(() => () => monitor.current?.stop(), []);
  return monitor.current;
}
