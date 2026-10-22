/** Process-local observation of actual external inference, never issued/idle credentials. */
export interface InferenceMetadata {
  sessionId: string;
  agentId: string;
  providerId: string;
  model: string;
}

export class InferenceActivity {
  readonly observedSince = new Date().toISOString();
  private sequence = 0;
  private requests = new Map<number, InferenceMetadata & { startedAt: string }>();

  begin(metadata: InferenceMetadata): () => void {
    const id = ++this.sequence;
    this.requests.set(id, { ...metadata, startedAt: new Date().toISOString() });
    // Both downstream close and the handler's finally may complete the same request.
    return () => { this.requests.delete(id); };
  }

  snapshot() {
    const sessions = new Map<string, { id: string; agentId: string; startedAt: string; requests: number; models: string[]; providerIds: string[] }>();
    for (const request of this.requests.values()) {
      let session = sessions.get(request.sessionId);
      if (!session) {
        session = { id: request.sessionId, agentId: request.agentId, startedAt: request.startedAt, requests: 0, models: [], providerIds: [] };
        sessions.set(request.sessionId, session);
      }
      session.requests++;
      if (!session.models.includes(request.model)) session.models.push(request.model);
      if (!session.providerIds.includes(request.providerId)) session.providerIds.push(request.providerId);
    }
    return { observedSince: this.observedSince, activeRequests: this.requests.size, sessions: [...sessions.values()] };
  }
}
