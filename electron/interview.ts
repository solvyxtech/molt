/**
 * Desktop re-export of the shared interview helper.
 *
 * The parser, the write gate, and the model round live in `src/` so the TUI
 * and the window cannot drift. This file exists so existing `electron/`
 * imports keep working.
 */
export {
  INTERVIEW_MAX_QUESTIONS,
  INTERVIEW_MAX_ROUNDS,
  applyBarAdds,
  interviewTurn,
  parseInterviewReply,
  parseQuestions,
  projectScripts,
  sanitizeAnswers,
  type BarAdd,
  type InterviewAnswer,
  type InterviewProposal,
  type InterviewQuestion,
  type InterviewTurn,
} from "../src/interview.js";
