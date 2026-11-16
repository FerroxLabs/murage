"""Expected to fail on this capture: r1.1 G2's no-start premise is false."""
from verify import starts

for scenario in ('unregistered-memory', 'unregistered-zz'):
    assert not starts(scenario), f'{scenario}: tool_call start observed; G2 requires fallback B'
