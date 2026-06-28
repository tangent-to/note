/** Surface a transient message via the app's toast UI instead of a blocking
 *  window.alert(). App.svelte listens for the 'tangent-toast' event. */
export function toast(message: string, tone: 'error' | 'info' = 'info'): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('tangent-toast', { detail: { message, tone } }));
}
