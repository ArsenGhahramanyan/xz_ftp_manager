import { PaneSide } from '../components/FilePane';

export interface DragPayload {
    side: PaneSide;
    paths: string[];
}

let current: DragPayload | null = null;

export function setDragPayload(payload: DragPayload): void {
    current = payload;
}

export function getDragPayload(): DragPayload | null {
    return current;
}

export function clearDragPayload(): void {
    current = null;
}
