export interface SuggestionRow {
  title: string;
  detail: string;
  selected: boolean;
  disabled: boolean;
}

export interface AddressSuggestionPopup {
  id: string;
  revision: number;
  presentation?: {
    height: number;
    paint: Omit<SuggestionPaint, "revision">;
  };
}

export interface SuggestionPaint {
  revision: number;
  rows: SuggestionRow[];
  fontSize: string;
  fontFamily: string;
}
