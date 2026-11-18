export interface TrulyReviewRow {
 id:string;
 actor:'owner';
 level:'unlimited';
 tool:string;
 input:Record<string,string>;
 expected:'RUN'|'CARD';
 expectedCards:0|1;
}
export const reviewRows:TrulyReviewRow[];
export const overflowPrefix:string;
