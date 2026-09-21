/** Shapes of the published vulnerability taxonomy graders pick from (see PATTERNS). */
import { PATTERNS } from './common.js';

/** A taxonomy leaf: a dotted snake_case path, e.g. `cross_site_scripting_xss.stored.non_privileged_user_to_anyone`. */
export const TAXONOMY_NODE_ID = PATTERNS['taxonomy-node-id'];

/** A CWE identifier, e.g. `CWE-79`. */
export const CWE_ID = PATTERNS['cwe-id'];

/** A CVSS 3.1 or 4.0 vector. */
export const CVSS_VECTOR = PATTERNS['cvss-vector'];
