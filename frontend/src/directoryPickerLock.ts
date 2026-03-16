let open = false;

export function isPickerOpen(): boolean {
  return open;
}

export function setPickerOpen(value: boolean): void {
  open = value;
}
