// Shared width threshold (in px, measured via useElementWidth — the card's own
// rendered content width, not the viewport) at which AgentCard's internal views
// switch from a stacked/vertical layout to a row/grid layout. One number so
// StaticAgentView and ActiveAgentView break at the same point.
export const CARD_LAYOUT_BREAKPOINT_PX = 600;
