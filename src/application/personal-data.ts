export interface DataPage {
  items: unknown[];
  total: number;
  next_offset: number | null;
}
export interface PersonalDataPort {
  memories(
    profile: string,
    search: string,
    category: string | undefined,
    offset: number,
    limit: number,
  ): Promise<DataPage>;
  forget(profile: string, ids: string[]): Promise<number>;
  conversations(
    session: string,
    query: string,
    start: string | undefined,
    end: string | undefined,
    offset: number,
    limit: number,
  ): Promise<DataPage>;
  message(session: string, id: string): Promise<unknown>;
}
