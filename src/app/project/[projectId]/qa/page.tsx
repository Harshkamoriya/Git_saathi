"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { askQuestion, type ChatTurn } from "@/lib/retrival";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Send, RotateCw, Trash2, AlertTriangle, Copy, Check } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { readStreamableValue } from "ai/rsc";
import CodeReferencePanel from "@/components/code-references";
import { MemoizedMarkdown } from "@/components/memorized-markdown";
import { useParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GetProjectById } from "@/lib/query";

interface FileReference {
  fileName: string;
  sourceCode?: string;
  summary: string;
  score?: number;
}

interface Message {
  id: string;
  content: string;
  type: "question" | "answer";
  filesReferences?: FileReference[];
  timestamp: Date;
  failed?: boolean;
  question?: string;
}

interface StoredMessages {
  messages: Message[];
  storedAt: number;
}

const HISTORY_TTL_MS = 2 * 60 * 60 * 1000;
const ANSWER_TIMEOUT_MS = 90000;
const MAX_STORED_MESSAGES = 50;

const RAW_ERROR_PATTERN = /TURBOPACK|invocation in|PrismaClient|at async /;

const SUGGESTIONS = [
  "What is this project about?",
  "How is the project structured?",
  "Which libraries and frameworks does it use?",
];

function loadHistory(storageKey: string): StoredMessages | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredMessages;
    if (Date.now() - parsed.storedAt >= HISTORY_TTL_MS) {
      localStorage.removeItem(storageKey);
      return null;
    }
    // Drop raw server stack traces and full file sources saved by older builds
    const messages = parsed.messages
      .filter((m) => !(m.type === "answer" && RAW_ERROR_PATTERN.test(m.content)))
      .map((m) => ({
        ...m,
        timestamp: new Date(m.timestamp),
        filesReferences: m.filesReferences?.map(({ fileName, summary, score }) => ({ fileName, summary, score })),
      }));
    return { messages, storedAt: parsed.storedAt };
  } catch {
    localStorage.removeItem(storageKey);
    return null;
  }
}

// Recent successful turns, so follow-ups like "where is it called?" keep their context
function historyFor(messages: Message[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    if (m.type !== "answer" || m.failed || prev?.type !== "question") return;
    turns.push({ role: "user", content: prev.content }, { role: "assistant", content: m.content });
  });
  return turns.slice(-6);
}

function CopyAnswerButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="flex items-center gap-1 text-xs text-gray-500 hover:text-orange-500 dark:text-gray-400"
      aria-label="Copy answer"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function ReferenceChips({
  references,
  onOpen,
}: {
  references: FileReference[];
  onOpen: (file: FileReference) => void;
}) {
  if (references.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
        {references.length} file reference{references.length > 1 ? "s" : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        {references.map((file) => (
          <button
            key={file.fileName}
            type="button"
            onClick={() => onOpen(file)}
            className="max-w-full truncate text-xs px-3 py-1 bg-orange-100 dark:bg-orange-900/60 text-gray-700 dark:text-gray-300 rounded-full hover:bg-orange-200 dark:hover:bg-orange-800 transition-colors"
          >
            {file.fileName}
          </button>
        ))}
      </div>
    </div>
  );
}

function BotAvatar() {
  return (
    <div className="w-9 h-9 rounded-full bg-orange-100 dark:bg-orange-900 flex items-center justify-center shrink-0">
      <Image src="/logo.png" alt="GitBuddy" width={22} height={22} />
    </div>
  );
}

export default function QA() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const storageKey = `chatMessages-${projectId}`;

  const queryClient = useQueryClient();
  const {
    data: project,
    isError: projectError,
    refetch: refetchProject,
    isFetching: projectFetching,
  } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => GetProjectById(projectId),
    enabled: !!projectId,
    retry: 3,
    retryDelay: (attempt) => Math.min(2000 * 2 ** attempt, 10000),
  });

  const reindexMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/reindex?projectId=${projectId}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Couldn't start reindexing. Please try again.");
      }
      return body;
    },
    onSuccess: () => {
      toast.success("Reindexing started. Ask me will be ready again in a few minutes.");
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeAnswer, setActiveAnswer] = useState("");
  const [activeReferences, setActiveReferences] = useState<FileReference[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedReference, setSelectedReference] = useState<FileReference | null>(null);
  const [currentReferenceFiles, setCurrentReferenceFiles] = useState<FileReference[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const storedAtRef = useRef<number | null>(null);
  const loadingRef = useRef(false);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 150)}px`;
    }
  }, [question]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, activeAnswer, isLoading]);

  useEffect(() => {
    const history = loadHistory(storageKey);
    storedAtRef.current = history?.storedAt ?? null;
    setMessages(history?.messages ?? []);
  }, [storageKey]);

  useEffect(() => {
    if (messages.length === 0) return;
    if (!storedAtRef.current) storedAtRef.current = Date.now();
    const data: StoredMessages = {
      messages: messages.slice(-MAX_STORED_MESSAGES),
      storedAt: storedAtRef.current,
    };
    localStorage.setItem(storageKey, JSON.stringify(data));

    const remaining = Math.max(0, HISTORY_TTL_MS - (Date.now() - storedAtRef.current));
    const timer = setTimeout(() => {
      localStorage.removeItem(storageKey);
      storedAtRef.current = null;
      setMessages([]);
    }, remaining);
    return () => clearTimeout(timer);
  }, [messages, storageKey]);

  const ask = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || loadingRef.current) return;
      loadingRef.current = true;

      const questionId = Date.now().toString();
      setMessages((prev) => [
        ...prev,
        { id: questionId, content: trimmed, type: "question", timestamp: new Date() },
      ]);
      setActiveAnswer("");
      setActiveReferences([]);
      setIsLoading(true);
      setSelectedReference(null);

      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const pushAnswer = (answer: Omit<Message, "id" | "type" | "timestamp">) =>
        setMessages((prev) => [
          ...prev,
          {
            id: `answer-${questionId}`,
            type: "answer",
            timestamp: new Date(),
            question: trimmed,
            ...answer,
          },
        ]);

      try {
        await Promise.race([
          (async () => {
            const { output, filesReferences } = await askQuestion(trimmed, projectId, historyFor(messages));
            if (cancelled) return;
            setActiveReferences(filesReferences);

            let fullAnswer = "";
            for await (const value of readStreamableValue(output)) {
              if (cancelled) return;
              if (typeof value === "string") {
                fullAnswer = value;
                setActiveAnswer(value);
              }
            }
            if (cancelled) return;

            pushAnswer({
              content: fullAnswer.trim() || "I couldn't produce an answer. Please try again.",
              filesReferences,
              failed: !fullAnswer.trim() || filesReferences.length === 0,
            });
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              cancelled = true;
              reject(new Error("timeout"));
            }, ANSWER_TIMEOUT_MS);
          }),
        ]);
      } catch (error) {
        console.error("Error asking question:", error);
        const timedOut = error instanceof Error && error.message === "timeout";
        const message = timedOut
          ? "This is taking too long. Please try again."
          : "I couldn't reach the server. Check your connection and try again.";
        toast.error(message);
        pushAnswer({ content: message, failed: true });
      } finally {
        if (timer) clearTimeout(timer);
        loadingRef.current = false;
        setIsLoading(false);
        setActiveAnswer("");
        setActiveReferences([]);
        textareaRef.current?.focus();
      }
    },
    [projectId, messages]
  );

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (isLoading || !question.trim()) return;
    const text = question;
    setQuestion("");
    ask(text);
  };

  const retry = (text: string) => {
    if (!isLoading) ask(text);
  };

  const clearChat = () => {
    localStorage.removeItem(storageKey);
    storedAtRef.current = null;
    setMessages([]);
  };

  const openReference = (file: FileReference, allReferences: FileReference[]) => {
    setSelectedReference(file);
    setCurrentReferenceFiles(allReferences);
  };

  const closeReference = () => {
    setSelectedReference(null);
    setCurrentReferenceFiles([]);
  };

  const lastMessage = messages[messages.length - 1];
  const unanswered = !isLoading && lastMessage?.type === "question" ? lastMessage : null;
  const indexingStatus = reindexMutation.isPending ? "INDEXING" : project?.indexingStatus;

  return (
    <div className="flex h-[calc(100dvh-8.5rem)] min-h-[28rem] flex-col overflow-hidden rounded-xl bg-gray-50 dark:bg-gray-900">
      <div className="flex items-center justify-between gap-4 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Image src="/logo.png" alt="GitBuddy" width={32} height={32} />
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-gray-800 dark:text-gray-100">Ask me</h1>
            {projectError ? (
              <button
                type="button"
                onClick={() => refetchProject()}
                className="flex items-center gap-1 text-sm text-amber-600 dark:text-amber-400 hover:underline"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                Couldn&apos;t load project details. Retry
              </button>
            ) : (
              <p className="truncate text-sm text-orange-500">
                {project?.name || (projectFetching ? "Loading project…" : "")}
                {project?.githubUrl ? (
                  <span className="text-gray-500 dark:text-gray-400">
                    {" · "}
                    {project.githubUrl.replace("https://github.com/", "")}
                  </span>
                ) : null}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {messages.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isLoading}
              onClick={clearChat}
              title="Clear chat"
              className="text-gray-500 hover:text-red-500"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={reindexMutation.isPending || !projectId || project?.indexingStatus === "INDEXING"}
            onClick={() => reindexMutation.mutate()}
          >
            {reindexMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Reindex"}
          </Button>
          {indexingStatus && (
            <span
              className={cn(
                "whitespace-nowrap rounded-full px-2 py-1 text-xs",
                indexingStatus === "COMPLETED"
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                  : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
              )}
            >
              {indexingStatus}
            </span>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl space-y-5 px-4 py-6 sm:px-6">
          {messages.length === 0 && !isLoading && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="py-10 text-center"
            >
              <Image src="/logo.png" alt="GitBuddy" width={72} height={72} className="mx-auto mb-4 opacity-70" />
              <h2 className="mb-2 text-2xl font-semibold text-gray-800 dark:text-gray-100">
                Ask about{" "}
                <span className="bg-gradient-to-r from-orange-500 to-pink-500 bg-clip-text text-transparent">
                  {project?.name || "this project"}
                </span>
              </h2>
              <p className="mx-auto mb-6 max-w-lg text-gray-500 dark:text-gray-400">
                Ask anything about this repo and get answers with code references.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => ask(s)}
                    className="rounded-full border border-orange-200 dark:border-orange-900/60 bg-white dark:bg-gray-800 px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:border-orange-400 hover:text-orange-500 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </motion.div>
          )}

          {messages.map((message) =>
            message.type === "question" ? (
              <motion.div
                key={message.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className="flex justify-end gap-3"
              >
                <div className="min-w-0 max-w-[80%] rounded-2xl rounded-br-sm bg-gradient-to-r from-orange-500 to-pink-500 px-4 py-3 text-white shadow-sm">
                  <p className="whitespace-pre-wrap break-words text-base leading-relaxed">{message.content}</p>
                  <p className="mt-1 text-right text-xs text-white/70">{format(message.timestamp, "MMM d, h:mm a")}</p>
                </div>
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-200 dark:bg-gray-600">
                  <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">U</span>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key={message.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className="flex justify-start gap-3"
              >
                <BotAvatar />
                <div
                  className={cn(
                    "min-w-0 max-w-[85%] overflow-hidden rounded-2xl rounded-bl-sm border px-4 py-3 shadow-sm",
                    message.failed && !message.filesReferences?.length
                      ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
                      : "border-gray-200 bg-white text-gray-800 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                  )}
                >
                  <div className="break-words">
                    <MemoizedMarkdown content={message.content} id={message.id} />
                  </div>
                  <ReferenceChips
                    references={message.filesReferences || []}
                    onOpen={(file) => openReference(file, message.filesReferences || [])}
                  />
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <p className="text-xs text-gray-500 dark:text-gray-400">{format(message.timestamp, "MMM d, h:mm a")}</p>
                      {!message.failed && <CopyAnswerButton text={message.content} />}
                    </div>
                    {message.failed && message.question && (
                      <button
                        type="button"
                        disabled={isLoading}
                        onClick={() => retry(message.question!)}
                        className="flex items-center gap-1 text-xs font-medium text-orange-600 dark:text-orange-400 hover:underline disabled:opacity-50"
                      >
                        <RotateCw className="h-3 w-3" />
                        Retry
                      </button>
                    )}
                  </div>
                </div>
              </motion.div>
            )
          )}

          {isLoading && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className="flex justify-start gap-3"
            >
              <BotAvatar />
              <div className="min-w-0 max-w-[85%] overflow-hidden rounded-2xl rounded-bl-sm border border-gray-200 bg-white px-4 py-3 shadow-sm dark:border-gray-700 dark:bg-gray-800">
                {activeAnswer ? (
                  <div className="break-words">
                    <MemoizedMarkdown content={activeAnswer} id="streaming-answer" />
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <Loader2 className="h-5 w-5 animate-spin text-orange-500" />
                    <p className="text-sm text-gray-600 dark:text-gray-300">Searching the repo and writing an answer…</p>
                  </div>
                )}
                <ReferenceChips
                  references={activeReferences}
                  onOpen={(file) => openReference(file, activeReferences)}
                />
              </div>
            </motion.div>
          )}

          {unanswered && (
            <div className="flex justify-start gap-3">
              <BotAvatar />
              <div className="flex items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
                This question didn&apos;t get an answer.
                <button
                  type="button"
                  onClick={() => {
                    setMessages((prev) => prev.slice(0, -1));
                    retry(unanswered.content);
                  }}
                  className="flex items-center gap-1 font-medium text-orange-600 dark:text-orange-400 hover:underline"
                >
                  <RotateCw className="h-3 w-3" />
                  Retry
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 sm:p-4">
        <form onSubmit={handleSubmit} className="mx-auto flex w-full max-w-4xl items-end gap-3">
          <Textarea
            ref={textareaRef}
            placeholder={isLoading ? "Waiting for the answer…" : "Ask about your codebase… (Shift+Enter for a new line)"}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={1}
            className="min-h-[52px] max-h-[150px] flex-grow resize-none rounded-xl border-gray-300 text-base text-gray-800 shadow-sm placeholder:text-gray-500 focus:ring-2 focus:ring-orange-500 dark:border-gray-600 dark:text-gray-200 dark:placeholder:text-gray-400"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
          <Button
            type="submit"
            disabled={isLoading || !question.trim()}
            className="h-[52px] rounded-xl bg-gradient-to-r from-orange-500 to-pink-500 px-4 font-semibold text-white shadow-sm transition-all hover:from-orange-600 hover:to-pink-600 disabled:opacity-50"
          >
            {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
          </Button>
        </form>
      </div>

      <AnimatePresence>
        {selectedReference && (
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            onClick={closeReference}
          >
            <CodeReferencePanel
              projectId={projectId}
              file={selectedReference}
              allReferences={currentReferenceFiles}
              onClose={closeReference}
              onChangeReference={setSelectedReference}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
