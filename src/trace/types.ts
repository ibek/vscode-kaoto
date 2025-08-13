/**
 * Exchange event parsed from Camel trace dump output.
 */
export interface ExchangeEvent {
	timestamp: string;
	step: string;
	status: string;
	headers: Record<string, string>;
	body: string;
	exchangeId: string;
}
