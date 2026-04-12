import React, { useRef, useEffect, Suspense, lazy } from "react";
import { useChatStore } from "../stores/chat-store.js";
import WelcomeScreen from "./WelcomeScreen.jsx";

const MessageBubble = lazy(() => import("./MessageBubble.jsx"));

export default function ChatView() {
  const messages = useChatStore((s) => s.messages);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div className="chat-view" ref={scrollRef}>
      {messages.length === 0 ? (
        <WelcomeScreen />
      ) : (
        <Suspense fallback={<div className="messages" aria-busy="true" />}>
          <div className="messages">
            {messages.map((msg, i) => (
              <MessageBubble key={i} message={msg} isLast={i === messages.length - 1} />
            ))}
          </div>
        </Suspense>
      )}
    </div>
  );
}
