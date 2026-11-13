// Island entry for the Companies tab (/admin/contacts/companies) (Admin v2 C11). The page
// hydrates this entry; the screen's code is in screens/contacts/ (CompaniesList), in the
// admin-contacts chunk group (astro.config.mjs), and the company drawer in
// admin-contacts-lazy, reached through import() only.
import CompaniesList, {
  type CompaniesListProps,
} from '@/components/admin/screens/contacts/CompaniesList';

export default function AdminContactCompanies(props: CompaniesListProps) {
  return <CompaniesList {...props} />;
}
