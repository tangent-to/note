/**
 * The side panel's tools, named once.
 *
 * The rail on the right edge, the panel itself and the app that opens it all
 * speak of the same five things; a shared type keeps them from drifting.
 */
export type PanelTab = 'info' | 'variables' | 'console' | 'chat' | 'storage';
