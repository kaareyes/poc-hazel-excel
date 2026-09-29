/** One row of the People worksheet. Column names match the Excel headers. */
export interface Person {
  Name: string;
  Gender: string;
  Location: string;
  city: string;
  province: string;
}

export const PERSON_COLUMNS: (keyof Person)[] = ["Name", "Gender", "Location", "city", "province"];
