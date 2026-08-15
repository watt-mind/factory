import { gql } from "./orchestrator/reaper.mjs";
import fs from "fs";

const key = process.argv[2];
const description = fs.readFileSync(process.argv[3], "utf8");

const d = await gql(`query($k:String!){ issue(id:$k){ id } }`, { k: key });
await gql(`mutation($id:String!,$in:IssueUpdateInput!){ issueUpdate(id:$id,input:$in){ success } }`, 
  { id: d.issue.id, in: { description } });
console.log("Updated", key);
