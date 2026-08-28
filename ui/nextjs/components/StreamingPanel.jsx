"use client";
import StreamingClient from "./StreamingClient";
export default function StreamingPanel(props) {
  const stream = StreamingClient(props);
  return <section aria-label="Live event stream" data-status={stream.status}><span>{stream.status}</span>{stream.messages.map((message) => <article key={message.message_id}>{message.payload?.text ?? message.payload?.error ?? message.message_type}</article>)}</section>;
}
