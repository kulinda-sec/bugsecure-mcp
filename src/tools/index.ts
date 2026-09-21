/**
 * The tool registry: every tool the server can offer, in one list.
 *
 * To add a tool: create `src/tools/<tool-name>.ts` exporting a `defineTool(...)`,
 * add its operations under `src/graphql/operations/`, and append it here.
 * See CONTRIBUTING.md § "Adding a tool".
 */
import { addReportComment } from './add-report-comment.js';
import { addTriageComment } from './add-triage-comment.js';
import { assignReport } from './assign-report.js';
import { checkDuplicates } from './check-duplicates.js';
import type { AnyTool } from './define-tool.js';
import { getLeaderboard } from './get-leaderboard.js';
import { getMyKycStatus } from './get-my-kyc-status.js';
import { getMyProfile } from './get-my-profile.js';
import { getOrgReport } from './get-org-report.js';
import { getOrgReportStats } from './get-org-report-stats.js';
import { getProgram } from './get-program.js';
import { getProgramTerms } from './get-program-terms.js';
import { getProgramStats } from './get-program-stats.js';
import { getReport } from './get-report.js';
import { getResearcherProfile } from './get-researcher-profile.js';
import { getTaxonomy } from './get-taxonomy.js';
import { gradeReport } from './grade-report.js';
import { listBadges } from './list-badges.js';
import { listMyCertificates } from './list-my-certificates.js';
import { listMyOrganizations } from './list-my-organizations.js';
import { listMyReports } from './list-my-reports.js';
import { listOrgCertificates } from './list-org-certificates.js';
import { listOrgPrograms } from './list-org-programs.js';
import { listNotifications } from './list-notifications.js';
import { listOrgReports } from './list-org-reports.js';
import { markNotificationsRead } from './mark-notifications-read.js';
import { raiseAppeal } from './raise-appeal.js';
import { saveDisclosureDraft } from './save-disclosure-draft.js';
import { search } from './search.js';
import { searchPrograms } from './search-programs.js';
import { submitReport } from './submit-report.js';
import { updateMyProfile } from './update-my-profile.js';
import { updateReportStatus } from './update-report-status.js';
import { verifyCertificate } from './verify-certificate.js';

export const ALL_TOOLS: readonly AnyTool[] = [
  // programs:read
  searchPrograms,
  getProgram,
  getLeaderboard,
  listBadges,
  getResearcherProfile,
  verifyCertificate,
  search,
  getTaxonomy,
  getProgramTerms,
  // profile:read
  getMyProfile,
  listNotifications,
  listMyCertificates,
  getMyKycStatus,
  // reports:read (researcher side: the user's own reports)
  listMyReports,
  getReport,
  // reports:write
  submitReport,
  addReportComment,
  raiseAppeal,
  // notifications:write
  markNotificationsRead,
  // profile:write (researchers only)
  updateMyProfile,
  // disclosures:write (researchers only; drafting, never publishing)
  saveDisclosureDraft,
  // triage:read (organization side: opted-in organizations only)
  listMyOrganizations,
  listOrgPrograms,
  listOrgReports,
  getOrgReport,
  getOrgReportStats,
  getProgramStats,
  checkDuplicates,
  listOrgCertificates,
  // triage:write
  updateReportStatus,
  addTriageComment,
  assignReport,
  // grade:write (organization side: organizations that opted in to AI grading only)
  gradeReport,
];
