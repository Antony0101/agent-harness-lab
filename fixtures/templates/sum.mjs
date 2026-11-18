// Deliberate bug for the harness workflow to repair.
export function sum(values) {
  return values.reduce((total, value) => total + value, 1);
}
