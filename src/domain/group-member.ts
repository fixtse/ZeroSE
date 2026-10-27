export interface GroupMember {
  userId: string;
  name: string;
  username: string;
  present: boolean;
  observed: boolean;
  locationEntity: string;
  geocodedLocationEntity: string;
}
