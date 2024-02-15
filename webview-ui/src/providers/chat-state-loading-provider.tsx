import React, {
  createContext,
  useEffect,
  useContext,
  useReducer,
  useRef
} from "react";
import { encode } from "js-base64";

import { useChatState } from "./chat-state-provider";
import { SessionContext } from "./session-provider";
import { API_BASE } from "../data/constants";
import {
  fetcher,
  getLatestCommit,
  serializeRepoKey
} from "../lib/onboard-utils";
import { type RepositoryInfo } from "../types/chat";

export type ChatLoadingState = {
  loadingRepoStates: { [repo: string]: RepositoryInfo };
}

const initialChatState = {
  loadingRepoStates: {},
}

export interface ChatStateAction {
  action: string;
  payload: any;
}

const chatLoadingStateReducer = (state: any, action: ChatStateAction) => {
  switch (action.action) {
    case "set_loading_repo_states":
      return {
        ...state,
        loadingRepoStates: action.payload,
      };
    default:
      return state;
  }
}

const ChatLoadingStateContext = createContext<{
  chatLoadingState: ChatLoadingState;
  chatLoadingStateDispatch: React.Dispatch<ChatStateAction>;
}>({
  chatLoadingState: initialChatState,
  chatLoadingStateDispatch: (action: ChatStateAction) => {},
});

export const useChatLoadingState = () => {
  const context = useContext(ChatLoadingStateContext);
  if (context === undefined) {
    throw new Error("useChatLoadingState must be used within a ChatLoadingStateProvider");
  }
  return context;
}

export function ChatLoadingStateProvider({
  children
}: {
  children: React.ReactNode
}) {
  const { chatState, chatStateDispatch } = useChatState();
  const [chatLoadingState, chatLoadingStateDispatch] = useReducer(
    chatLoadingStateReducer, {
    ...initialChatState,
    loadingRepoStates: chatState.repoStates
  });

  const { session } = useContext(SessionContext);
  const isCancelled = useRef(false);
  useEffect(() => {
    // console.log('useEffect for polling', chatState.repoStates);
    isCancelled.current = false;
    const poll = async () => {
      // console.log('polling repo states')
      let newRepoStates = chatState.repoStates;

      const submitReposProcessing = Object.keys(newRepoStates).map(
        async (repoKey) => {
          const version = await getLatestCommit(repoKey, session);
          if (
            newRepoStates[repoKey].sha &&
            version !== newRepoStates[repoKey].sha &&
            newRepoStates[repoKey].status === "completed"
          ) {
            fetch(`${API_BASE}/prod/v1/repositories`, {
              method: "POST",
              body: JSON.stringify({
                remote: "github", // todo: update
                repository: newRepoStates[repoKey].repository,
                notify: false,
              }),
              headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + session?.user?.tokens?.github.accessToken
              },
            });
          }
        }
      );
      await Promise.allSettled(submitReposProcessing);
      await new Promise((resolve) => setTimeout(resolve, 2000));

      let metalIndex: { [key: string]: { status: string } } = {};
      const submitMetalIndexProcessing = Object.keys(newRepoStates).map(
        async (repo) => {
          let metalIndexInfo = await fetcher(`${API_BASE}/repositories/${encode(repo, true)}/status`, {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " +  session?.user?.tokens?.github.accessToken
            },
          }); // .then((res) => res.status);
          metalIndex[repo] = metalIndexInfo;
        }
      );
      await Promise.allSettled(submitMetalIndexProcessing);

      // set status to processing for all, to at least check once
      Object.keys(newRepoStates).forEach((repoKey) => {
        newRepoStates[repoKey] = {
          ...newRepoStates[repoKey],
          status: "processing",
        };
      });

      let maxTries = 1000000000; // lol
      const repoFailureCount: { [key: string]: number } = {};
      const clonedReposWaitingForUnarchive: string[] = [];
      while (!isCancelled.current && maxTries-- > 0) {
        // console.log('polling', newRepoStates, isCancelled.current);
        let repos = Object.keys(newRepoStates).filter(
          (repo) =>
            !newRepoStates[repo].indexId || 
            !newRepoStates[repo].repository ||
            (newRepoStates[repo].status !== "completed" &&
              (repoFailureCount[repo] || 0) < 3 &&
              !clonedReposWaitingForUnarchive.includes(repo)),
        );

        // potential problem: initialAdditionalRepos is deleted during chat
        // but once new repos are set it still polls for the repos as well.
        if (repos.length === 0) break;
        const response: any = await fetcher(`${API_BASE}/repositories/batch?repositories=${repos.map((repo) => encode(repo, true)).join(",")}`, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + session?.user?.tokens?.github.accessToken
          },
        })
        // const response = [repoInfo.responses[0]]; // todo: catch and handle failed repos

        for (const repoStatus of response) {
          // TODO: handle error in some
          // console.log("repo status: ", repoStatus);

          const repoKey = serializeRepoKey({
            repository: repoStatus.repository,
            branch: repoStatus.branch,
            remote: repoStatus.remote,
          });
          newRepoStates[repoKey] = {
            ...newRepoStates[repoKey],
            ...repoStatus,
            numFiles: repoStatus.numFiles,
            filesProcessed: repoStatus.filesProcessed,
            status:
              repoStatus.status === "completed" &&
              metalIndex[repoKey]?.status === "LIVE"
                ? "completed"
                : repoStatus.status,
          };
          if (
            repoStatus.status === "completed" &&
            !clonedReposWaitingForUnarchive.includes(repoKey)
          ) {
            clonedReposWaitingForUnarchive.push(repoKey);
          }
          if (repoStatus.status === "failed") {
            repoFailureCount[repoKey] =
              (repoFailureCount[repoKey] || 0) + 1;
          }
        }

        // console.log('polling set loading repos 1')
        chatLoadingStateDispatch({
          action: "set_loading_repo_states",
          payload: { ...chatLoadingState.loadingRepoStates, ...newRepoStates},
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      // console.log('polling set loading repos 2')
      chatLoadingStateDispatch({
        action: "set_loading_repo_states",
        payload: { ...chatLoadingState.loadingRepoStates, ...newRepoStates},
      });

      await Promise.all(
        Object.keys(metalIndex).map(async (repo) => {
          while (metalIndex[repo]?.status !== "LIVE") {
            if (metalIndex[repo]?.status === "ARCHIVED") {
              fetcher(`${API_BASE}/repositories/${encode(repo, true)}/unarchive`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": "Bearer " + session?.user?.tokens?.github.accessToken
                },
              });
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
            if (newRepoStates[repo].indexId) {
              metalIndex = await fetcher(`${API_BASE}/repositories/${encode(repo, true)}/status`, {
                method: "GET",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": "Bearer " +  session?.user?.tokens?.github.accessToken,
                },
              }).then((res) => res.status);
            }
            newRepoStates[repo] = {
              ...newRepoStates[repo],
              status:
                metalIndex[repo]?.status === "LIVE"
                  ? "completed"
                  : "processing"
            };
          }
        })
      );
      // console.log('polling set loading repos 4')
      chatLoadingStateDispatch({
        action: "set_loading_repo_states",
        payload: { ...chatLoadingState.loadingRepoStates, ...newRepoStates},
      });
      // console.log('done polling, pushing changes to context above')
      // this update will trigger the poll again, but it should exit if done
      chatStateDispatch({
        action: "set_repo_states",
        payload: newRepoStates,
      });
    };
    poll();
    return () => {
      // TODO: this is not exiting properly
      isCancelled.current = true;
    };
  }, [chatState.repoStates, chatStateDispatch]);

  return (
    <ChatLoadingStateContext.Provider
      value={{chatLoadingState, chatLoadingStateDispatch}}
    >
      {children}
    </ChatLoadingStateContext.Provider>
  );
}
