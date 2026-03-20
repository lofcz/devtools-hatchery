export type NetworkEntry = {
  url: string;
  name: string;
  domain: string;
  transferSize: number;
  statusCode: number;
  timestamp: number;
  contentType: string;
  duration: number;
  pending?: boolean;
};

export type FilterRule = {
  id: string;
  pattern: string;
  enabled: boolean;
};

// ---------------------------------------------------------------------------
// Recording / gesture types
// ---------------------------------------------------------------------------

export type Interaction = {
  type: "click" | "navigate" | "submit";
  timestamp: number;
  element?: {
    tag: string;
    text: string;
    id?: string;
    className?: string;
    selector: string;
  };
  fromUrl?: string;
  toUrl?: string;
};

export type Recording = {
  startTime: number;
  endTime: number;
  startUrl: string;
  endUrl: string;
  interactions: Interaction[];
};

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type AddEntryMessage = {
  type: "addEntry";
  payload: { tabId: number; entry: NetworkEntry };
};

export type ClearMessage = {
  type: "clear";
  payload: { tabId: number };
};

export type GetEntriesMessage = {
  type: "getEntries";
  payload: { tabId: number };
};

export type GetEntriesResponse = {
  entries: NetworkEntry[];
};

export type GetPendingMessage = {
  type: "getPending";
  payload: { tabId: number };
};

export type GetPendingResponse = {
  entries: NetworkEntry[];
};

export type SetPausedMessage = {
  type: "setPaused";
  payload: { tabId: number; paused: boolean };
};

export type GetPausedMessage = {
  type: "getPaused";
  payload: { tabId: number };
};

export type GetPausedResponse = {
  paused: boolean;
};

export type StartRecordingMessage = {
  type: "startRecording";
  payload: { tabId: number };
};

export type StopRecordingMessage = {
  type: "stopRecording";
  payload: { tabId: number };
};

export type IsRecordingMessage = {
  type: "isRecording";
  payload: { tabId: number };
};

export type IsRecordingResponse = {
  recording: boolean;
  startTime?: number;
};

export type PanelMessage =
  | ClearMessage
  | GetEntriesMessage
  | GetPendingMessage
  | SetPausedMessage
  | GetPausedMessage
  | StartRecordingMessage
  | StopRecordingMessage
  | IsRecordingMessage;
