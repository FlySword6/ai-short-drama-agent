/**
 * The collaborator picker is intentionally narrower than the administration
 * user list. It is safe for any signed-in teammate to search active people by
 * a deliberate query, without receiving platform roles, emails, or audit data.
 */
export interface DirectoryUser {
  id: string;
  username: string;
  displayName: string;
  active: boolean;
}

export interface UserDirectoryStore {
  searchActiveUsers(query: string, limit: number): Promise<DirectoryUser[]>;
}
