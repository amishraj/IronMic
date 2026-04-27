/**
 * TensorFlow.js services — public API for ML features.
 *
 * Usage in components/stores:
 *   import { TFJSRuntime, audioBridge } from '../services/tfjs';
 *   import { MLClient } from '../workers/ml-client';
 */

export { TFJSRuntime } from './TFJSRuntime';
export { VADService, vadService } from './VADService';
export type { VADResult, VoiceState } from './VADService';
export { TurnDetector, turnDetector } from './TurnDetector';
export type { TurnEvent } from './TurnDetector';
export { IntentClassifier, intentClassifier } from './IntentClassifier';
export type { ClassifiedIntent, IntentType } from './IntentClassifier';
export { VoiceRouter, voiceRouter } from './VoiceRouter';
export type { RoutingDecision } from './VoiceRouter';
export { MeetingDetector, meetingDetector } from './MeetingDetector';
export type { MeetingState, MeetingSegment, MeetingResult } from './MeetingDetector';
export { SemanticSearch, semanticSearch } from './SemanticSearch';
export type { SemanticSearchResult, IndexingProgress } from './SemanticSearch';
export { NotificationRanker, notificationRanker } from './NotificationRanker';
export type { RankedNotification } from './NotificationRanker';
export { WorkflowMiner, workflowMiner } from './WorkflowMiner';
export type { DiscoveredWorkflow, ActionEntry } from './WorkflowMiner';
