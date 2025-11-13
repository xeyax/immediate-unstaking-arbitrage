# Coding Standards

## Common

- Always use English for writing any comment/code/architecture documentation

## Development Principles

### Minimal Changes Principle
- **Always strive for minimal code changes**
- Avoid refactoring unrelated to current task
- One PR = one logical feature/fix
- Don't change code style in unrelated parts when fixing bugs
- Use incremental approach for improvements

### Code Quality
- Write self-documenting code
- Prefer explicit over implicit
- Follow DRY principle but avoid premature abstraction
- Optimize for readability over cleverness

## Solidity Standards

### Naming Conventions
- **Contracts**: PascalCase (`LeverageStrategy`)
- **Functions**: camelCase (`calculateLeverage()`)
- **Variables**: camelCase (`totalAssets`)
- **Constants**: UPPER_SNAKE_CASE (`MAX_LEVERAGE_RATIO`)
- **Events**: PascalCase (`PositionUpdated`)
- **Errors**: PascalCase with descriptive names (`InsufficientCollateral`)

### Documentation
- Use NatSpec for all public/external functions
- Document complex business logic
- Include @param and @return for all parameters
- Add security considerations for sensitive functions

### Testing Standards
- 100% test coverage for critical paths
- Test both success and failure scenarios
- Use descriptive test names
- Mock external dependencies
- Test edge cases and boundary conditions

## TypeScript Standards

### General Rules
- Use strict TypeScript configuration
- Prefer `const` over `let`
- Use descriptive variable names
- Avoid `any` type
- Use interfaces for object shapes

### Testing
- Use describe/it pattern
- One assertion per test when possible
- Use meaningful test descriptions
- Clean up after tests
