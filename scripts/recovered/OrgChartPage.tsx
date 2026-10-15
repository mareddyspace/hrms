import { Card, Page } from "../components/ui.tsx";
import { OrgChart } from "../components/OrgChart.tsx";
import { COMPANY_NAME } from "../brand.ts";

export function OrgChartPage() {
  return (
    <Page
      title="Org chart"
      subtitle={`${COMPANY_NAME} demo reporting structure — who reports to whom`}
    >
      <Card title="Company hierarchy">
        <OrgChart />
      </Card>
    </Page>
  );
}
