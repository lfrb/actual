/** Context for one serialized hosted RPC while its engine handler is running. */
export type RemoteOperationContext = {
  budgetId: string;
  credentialId: string;
  requestId: string;
};

let currentContext: RemoteOperationContext | null = null;
let hostedBudgetActive = false;

export function setRemoteOperationContext(
  context: RemoteOperationContext | null,
) {
  currentContext = context;
}

export function getRemoteOperationContext() {
  return currentContext;
}

export function setHostedBudgetActive(active: boolean) {
  hostedBudgetActive = active;
}

export function isHostedBudgetActive() {
  return hostedBudgetActive;
}
