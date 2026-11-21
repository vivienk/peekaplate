export const PRODUCTION_OWNER_ORIGIN = 'https://peekaplate.app';
export const PRODUCTION_DINER_ORIGIN = 'https://diner.peekaplate.app';

export function ownerWorkflowAvailable(env?: {
  APP_ENV?: string;
  OWNER_WORKFLOW_ENABLED?: string;
}): boolean {
  return (
    env?.APP_ENV === 'local' ||
    env?.APP_ENV === 'staging' ||
    (env?.APP_ENV === 'production' && env.OWNER_WORKFLOW_ENABLED === 'true')
  );
}
