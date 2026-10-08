// Queues owner messages locally so each selected agent receives them only after its current reply completes.
"use client";

import { useEffect, useRef, useState } from "react";

// Manages an agent-scoped FIFO queue without persisting queued owner requests.
export function usePendingConversationQueue({ agentId, isWorking, onSend }) {
  const [pendingMessages, setPendingMessages] = useState([]);
  const pendingRef = useRef([]);
  const onSendRef = useRef(onSend);
  const wasWorkingRef = useRef(isWorking);
  const flushingRef = useRef(false);
  const sequenceRef = useRef(0);

  useEffect(() => {
    onSendRef.current = onSend;
  }, [onSend]);

  useEffect(() => {
    pendingRef.current = [];
    setPendingMessages([]);
    wasWorkingRef.current = isWorking;
  }, [agentId]);

  useEffect(() => {
    if (isWorking) {
      wasWorkingRef.current = true;
      return;
    }
    if (!wasWorkingRef.current || flushingRef.current) return;
    wasWorkingRef.current = false;
    const nextMessage = pendingRef.current[0];
    if (!nextMessage) return;
    pendingRef.current = pendingRef.current.slice(1);
    setPendingMessages(pendingRef.current);
    flushingRef.current = true;
    Promise.resolve(onSendRef.current(nextMessage.text))
      .catch((error) => {
        console.error("Unable to send pending conversation message", error);
        pendingRef.current = [nextMessage, ...pendingRef.current];
        setPendingMessages(pendingRef.current);
      })
      .finally(() => {
        flushingRef.current = false;
      });
  }, [isWorking]);

  // Sends immediately when idle or retains the message until the active agent finishes.
  function submitMessage(text) {
    if (!isWorking) return onSendRef.current(text);
    sequenceRef.current += 1;
    const pendingMessage = { id: `pending-${agentId ?? "agent"}-${sequenceRef.current}`, text };
    pendingRef.current = [...pendingRef.current, pendingMessage];
    setPendingMessages(pendingRef.current);
    return undefined;
  }

  // Removes a queued request before it is sent to the selected agent.
  function cancelPendingMessage(id) {
    pendingRef.current = pendingRef.current.filter((message) => message.id !== id);
    setPendingMessages(pendingRef.current);
  }

  return { pendingMessages, submitMessage, cancelPendingMessage };
}

// Shows queued requests beside project and Git status so owners can cancel them before dispatch.
export function PendingConversationQueue({ pendingMessages, onCancel }) {
  if (pendingMessages.length === 0) return null;
  return <div className="home-plan-approval-notice" role="status" aria-label="Pending messages">
    <span>{pendingMessages.length} pending {pendingMessages.length === 1 ? "message" : "messages"}</span>
    {pendingMessages.map((message) => <button type="button" key={message.id} onClick={() => onCancel(message.id)} aria-label={`Cancel pending message: ${message.text}`} title="Cancel pending message">×</button>)}
  </div>;
}
