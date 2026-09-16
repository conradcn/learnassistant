// FRACTAL: implements (none) | component C0
export const IS_RELEASE: boolean =
  process.env.NODE_ENV === 'production' && process.env.LA_IS_RELEASE !== '0';

export function assertNotInRelease(surface: string): void {
  if (IS_RELEASE) {
    throw new Error(`${surface} is not available in the release build.`);
  }
}
